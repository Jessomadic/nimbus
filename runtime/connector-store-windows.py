"""Private pipe helper. No command-line secrets, enrollment, fallback, or ACL repair."""
import ctypes as c
from ctypes import wintypes as w
import hashlib, json, ntpath, struct, sys
k = c.WinDLL("kernel32", use_last_error=True)
a = c.WinDLL("advapi32", use_last_error=True)
crypt = c.WinDLL("crypt32", use_last_error=True)
k.CreateFileW.restype = w.HANDLE
k.CreateFileW.argtypes = [w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
k.CloseHandle.argtypes = [w.HANDLE]
k.LocalFree.argtypes = [c.c_void_p]
a.GetSecurityInfo.argtypes = [w.HANDLE,c.c_int,w.DWORD,c.POINTER(c.c_void_p),c.c_void_p,c.POINTER(c.c_void_p),c.c_void_p,c.POINTER(c.c_void_p)]
a.ConvertSidToStringSidW.argtypes = [c.c_void_p,c.POINTER(w.LPWSTR)]
a.GetAce.argtypes = [c.c_void_p,w.DWORD,c.POINTER(c.c_void_p)]
class ACL(c.Structure):
    _fields_ = [("revision",w.BYTE),("reserved",w.BYTE),("size",w.WORD),("count",w.WORD),("reserved2",w.WORD)]
class INFO(c.Structure):
    _fields_ = [("attributes",w.DWORD),("creation",w.FILETIME),("access",w.FILETIME),("write",w.FILETIME),("volume",w.DWORD),("high",w.DWORD),("low",w.DWORD),("links",w.DWORD),("indexHigh",w.DWORD),("indexLow",w.DWORD)]
k.GetFileInformationByHandle.argtypes = [w.HANDLE,c.POINTER(INFO)]
k.ReadFile.argtypes = [w.HANDLE,c.c_void_p,w.DWORD,c.POINTER(w.DWORD),c.c_void_p]
class BLOB(c.Structure):
    _fields_ = [("size",w.DWORD),("data",c.POINTER(c.c_ubyte))]
crypt.CryptUnprotectData.argtypes = [c.POINTER(BLOB),c.c_void_p,c.c_void_p,c.c_void_p,c.c_void_p,w.DWORD,c.POINTER(BLOB)]
def check(v):
    if not v: raise ValueError()
def sid(pointer):
    out = w.LPWSTR()
    check(a.ConvertSidToStringSidW(pointer,c.byref(out)))
    try: return out.value
    finally: k.LocalFree(c.cast(out,c.c_void_p))
def acl(handle, owner, strict):
    op, dp, sd = c.c_void_p(), c.c_void_p(), c.c_void_p()
    check(a.GetSecurityInfo(handle,1,5,c.byref(op),None,c.byref(dp),None,c.byref(sd)) == 0)
    try:
        check(sid(op) in {owner,"S-1-5-18","S-1-5-32-544"} and dp.value)
        head = c.cast(dp,c.POINTER(ACL)).contents
        check(head.count > 0)
        for n in range(head.count):
            ace = c.c_void_p()
            check(a.GetAce(dp,n,c.byref(ace)))
            raw = c.string_at(ace,8)
            kind, flags, size, mask = struct.unpack("<BBHI",raw)
            # Reject exotic/object/callback ACEs rather than guessing effective access.
            check(kind in (0,1) and size >= 12)
            if kind == 0 and sid(ace.value+8) not in {owner,"S-1-5-18","S-1-5-32-544"}:
                # Private objects remain private even for inheritance-only grants.
                check(not strict)
                # INHERIT_ONLY does not grant access on this ancestor. Every
                # actual descendant is independently checked under held handles.
                if flags & 0x08:
                    continue
                # Expand generic rights using FILE_GENERIC_* directory semantics.
                # Never confuse a generic grant with a harmless unknown bit.
                for generic, specific in ((0x10000000,0x1F01FF),
                                          (0x20000000,0x1200A0),
                                          (0x40000000,0x120116),
                                          (0x80000000,0x120089)):
                    if mask & generic:
                        mask = (mask & ~generic) | specific
                check(not (mask & 0x000D0156))
    finally: k.LocalFree(sd)
def run(req):
    check(set(req) == {"file","ownerSid","sha256"})
    file, owner, digest = req["file"], req["ownerSid"], req["sha256"]
    check(isinstance(file,str) and len(file) < 240 and len(digest)==64)
    check(len(file)>3 and file[1:3]==":\\" and file[0].isalpha() and ":" not in file[2:])
    check(ntpath.normpath(file)==file and all(p and p not in (".","..") and not p.endswith((" ",".")) for p in file[3:].split("\\")))
    # Token identity is native, not an environment/profile string.
    token = w.HANDLE()
    k.GetCurrentProcess.restype = w.HANDLE
    a.OpenProcessToken.argtypes = [w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)]
    a.GetTokenInformation.argtypes = [w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.POINTER(w.DWORD)]
    check(a.OpenProcessToken(k.GetCurrentProcess(),8,c.byref(token)))
    try:
        size=w.DWORD()
        a.GetTokenInformation(token,1,None,0,c.byref(size))
        buf=c.create_string_buffer(size.value)
        check(a.GetTokenInformation(token,1,buf,size,c.byref(size)))
        check(sid(c.cast(buf,c.POINTER(c.c_void_p)).contents.value)==owner)
    finally: k.CloseHandle(token)
    handles=[]
    try:
        parts=file[3:].split("\\")
        for i in range(len(parts)+1):
            p=file[:3]+"\\".join(parts[:i])
            final=i==len(parts)
            # Hold every ancestor against replacement; no write/delete sharing.
            h=k.CreateFileW(p,0x20080 | (0x80000000 if final else 0),1,None,3,0x02200000,None)
            check(h not in (None,c.c_void_p(-1).value))
            handles.append(h)
            info=INFO()
            check(k.GetFileInformationByHandle(h,c.byref(info)))
            check(not info.attributes & 0x400)
            check(bool(info.attributes & 0x10) != final)
            acl(h,owner,final or i==len(parts)-1)
        check(info.links==1 and info.high==0 and 0 < info.low <=65536)
        buf=c.create_string_buffer(65537); read=w.DWORD()
        check(k.ReadFile(handles[-1],buf,65537,c.byref(read),None))
        check(read.value==info.low)
        data=buf.raw[:read.value]
        check(hashlib.sha256(data).hexdigest()==digest)
        # DPAPI blob flags: reject machine-scope even with matching owner metadata.
        check(len(data)>44 and struct.unpack_from("<I",data,0)[0]==1 and not struct.unpack_from("<I",data,40)[0]&4)
        source=BLOB(len(data),c.cast(buf,c.POINTER(c.c_ubyte))); out=BLOB()
        check(crypt.CryptUnprotectData(c.byref(source),None,None,None,None,1,c.byref(out)))
        try:
            check(24<=out.size<=65536)
            plain=c.string_at(out.data,out.size)
            check(all(33<=b<=126 for b in plain))
            sys.stdout.buffer.write(plain); sys.stdout.buffer.flush()
        finally:
            if out.data:
                c.memset(out.data,0,out.size); k.LocalFree(out.data)
            c.memset(buf,0,len(buf))
    finally:
        for h in reversed(handles): k.CloseHandle(h)
if __name__=="__main__":
    try:
        raw=sys.stdin.buffer.read(8193)
        check(len(raw)<=8192)
        run(json.loads(raw))
    except BaseException:
        sys.exit(1)
