// Host-internal Windows N-API bridge. No fallback and no caller-selected root roles.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <wincrypt.h>
#include <sddl.h>
#include <userenv.h>
#include <bcrypt.h>
#ifndef NIMBUS_BROKER
#include <node_api.h>
#endif
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstring>
#pragma comment(lib,"advapi32.lib")
#pragma comment(lib,"userenv.lib")
#pragma comment(lib,"crypt32.lib")
#pragma comment(lib,"bcrypt.lib")
struct Handle { HANDLE h=INVALID_HANDLE_VALUE; explicit Handle(HANDLE v):h(v){} ~Handle(){if(h!=INVALID_HANDLE_VALUE&&h)CloseHandle(h);} Handle(const Handle&)=delete; };
struct Local { void* p=nullptr; ~Local(){if(p)LocalFree(p);} };
void require(bool b,const char* stage){if(!b)throw std::runtime_error(stage);}
std::wstring sid(PSID s){Local p; require(ConvertSidToStringSidW(s,(LPWSTR*)&p.p)!=0,"sid");return (wchar_t*)p.p;}
struct Identity { std::wstring owner,profile; Identity(){
 HANDLE t=nullptr; require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&t)!=0,"token"); Handle token(t);
 DWORD n=0;GetTokenInformation(t,TokenUser,nullptr,0,&n);std::vector<BYTE>b(n);
 require(GetTokenInformation(t,TokenUser,b.data(),n,&n)!=0,"token");owner=sid(((TOKEN_USER*)b.data())->User.Sid);
 n=0;GetUserProfileDirectoryW(t,nullptr,&n);std::vector<wchar_t>p(n);
 require(GetUserProfileDirectoryW(t,p.data(),&n)!=0,"profile");profile=p.data();
}};
void acl(HANDLE h,const std::wstring& owner,bool strict,bool osRoot=false){
 PSID o=nullptr; PACL d=nullptr;Local sd;
 require(GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&o,nullptr,&d,nullptr,(PSECURITY_DESCRIPTOR*)&sd.p)==ERROR_SUCCESS,"acl-query");
 auto trusted=[&](PSID s){auto v=sid(s);return v==owner||v==L"S-1-5-18"||v==L"S-1-5-32-544"||(osRoot&&v==L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");};
 require(o&&trusted(o)&&d&&d->AceCount,"acl-owner");
 for(DWORD i=0;i<d->AceCount;i++){void* p=nullptr;require(GetAce(d,i,&p)!=0,"ace");
 auto a=(ACCESS_ALLOWED_ACE*)p;require(a->Header.AceType==ACCESS_ALLOWED_ACE_TYPE||a->Header.AceType==ACCESS_DENIED_ACE_TYPE,"ace-type");
 require(a->Header.AceSize>=sizeof(ACCESS_ALLOWED_ACE),"ace-size");
 if(a->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&!trusted((PSID)&a->SidStart)){
 require(!strict,"acl-private");if(a->Header.AceFlags&INHERIT_ONLY_ACE)continue;
 DWORD m=a->Mask;GENERIC_MAPPING gm={FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};MapGenericMask(&m,&gm);
 require(!(m&(osRoot?0x000D0152:0x000D0156)),"acl-mutation");
 }}
}
std::string hash(const std::vector<BYTE>&b){BYTE out[32];require(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,(PUCHAR)b.data(),(ULONG)b.size(),out,32)==0,"hash");const char*hex="0123456789abcdef";std::string r;for(auto v:out){r+=hex[v>>4];r+=hex[v&15];}return r;}
std::wstring identity(HANDLE h){FILE_ID_INFO i{};require(GetFileInformationByHandleEx(h,FileIdInfo,&i,sizeof(i))!=0,"identity");wchar_t buf[64];swprintf_s(buf,L"%016llx:",i.VolumeSerialNumber);std::wstring r=buf;for(auto b:i.FileId.Identifier){swprintf_s(buf,L"%02x",b);r+=buf;}return r;}
struct Chain {
 std::vector<HANDLE> hs;std::vector<std::wstring> ids;std::vector<BYTE> bytes; std::wstring owner; bool rootMatched=false;
 ~Chain(){for(auto h:hs)CloseHandle(h);}
 Chain(std::wstring path,const Identity& who):owner(who.owner){
 require(path.size()>3&&path.size()<240&&path[1]==L':'&&path[2]==L'\\'&&path.find(L'/',0)==std::wstring::npos&&path.find(L':',2)==std::wstring::npos,"path");
 require(path.size()>who.profile.size()+1&&_wcsnicmp(path.c_str(),who.profile.c_str(),who.profile.size())==0&&path[who.profile.size()]==L'\\',"profile-binding");
 try{
 for(size_t end=3;;){
 auto part=path.substr(0,end); if(end>3){auto p=part.substr(part.find_last_of(L'\\')+1);require(!p.empty()&&p!=L"."&&p!=L".."&&p.back()!=L'.'&&p.back()!=L' ',"path");}
 bool final=end==path.size();
 HANDLE h=CreateFileW(part.c_str(),READ_CONTROL|FILE_READ_ATTRIBUTES|(final?GENERIC_READ:0),FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
 require(h!=INVALID_HANDLE_VALUE,"open");hs.push_back(h);
 BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(h,&info)!=0,"stat");
 require(!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT),"reparse");
 require(bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=final,"kind");
 ids.push_back(identity(h));
 if(final){require(info.nNumberOfLinks==1&&!info.nFileSizeHigh&&info.nFileSizeLow>44&&info.nFileSizeLow<=65536,"size-links");
 bytes.resize(info.nFileSizeLow);DWORD n;require(ReadFile(h,bytes.data(),(DWORD)bytes.size(),&n,nullptr)&&n==bytes.size(),"read");break;}
 end=path.find(L'\\',end==3?3:end+1);if(end==std::wstring::npos)end=path.size();else if(end==3)end++; // normal drive-root -> first component
 }
 wchar_t windows[MAX_PATH];require(GetWindowsDirectoryW(windows,MAX_PATH)>0,"os-root");
 std::wstring root(windows,3);require(GetDriveTypeW(root.c_str())==DRIVE_FIXED,"volume");
 Handle os(CreateFileW(root.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
 require(os.h!=INVALID_HANDLE_VALUE,"os-root-open");rootMatched=identity(os.h)==ids[0];
 for(size_t i=hs.size();i-->0;)acl(hs[i],owner,i+2>=hs.size(),i==0&&rootMatched);
 }catch(...){for(auto h:hs)CloseHandle(h);hs.clear();throw;}
 }
 void recheck(){for(size_t i=0;i<hs.size();i++){acl(hs[i],owner,i+2>=hs.size(),i==0&&rootMatched);require(identity(hs[i])==ids[i],"identity-changed");}}
};
#ifndef NIMBUS_BROKER
std::wstring str(napi_env e,napi_value v){size_t n;require(napi_get_value_string_utf16(e,v,nullptr,0,&n)==napi_ok&&n<1024,"argument");std::vector<char16_t>b(n+1);require(napi_get_value_string_utf16(e,v,b.data(),b.size(),&n)==napi_ok,"argument");return std::wstring((wchar_t*)b.data(),n);}
napi_value string(napi_env e,const std::wstring&s){napi_value v;napi_create_string_utf16(e,(const char16_t*)s.data(),s.size(),&v);return v;}
napi_value invoke(napi_env e,napi_callback_info info){
 try{size_t n=3;napi_value a[3];void* mode;require(napi_get_cb_info(e,info,&n,a,nullptr,&mode)==napi_ok,"argument");Identity who;
 if((size_t)mode==0){return string(e,who.profile);}
 require(n>=1,"argument");auto path=str(e,a[0]);Chain c(path,who);auto digest=hash(c.bytes);
 std::wstring binding=who.owner+L"|";for(auto&id:c.ids)binding+=id+L"|";binding+=std::wstring(digest.begin(),digest.end());
 if((size_t)mode==1){c.recheck();return string(e,binding);}
 require(n==2&&str(e,a[1])==binding,"binding");
 DWORD flags;memcpy(&flags,c.bytes.data()+40,4);require(!(flags&CRYPTPROTECT_LOCAL_MACHINE),"machine-scope");
 DATA_BLOB in{(DWORD)c.bytes.size(),c.bytes.data()},out{};require(CryptUnprotectData(&in,nullptr,nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&out)!=0,"decrypt");
 Local plain;plain.p=out.pbData;
 try{require(out.cbData>=24&&out.cbData<=65536,"plaintext-size");for(DWORD i=0;i<out.cbData;i++)require(out.pbData[i]>=33&&out.pbData[i]<=126,"plaintext-format");c.recheck();napi_value result;require(napi_create_buffer_copy(e,out.cbData,out.pbData,nullptr,&result)==napi_ok,"buffer");SecureZeroMemory(out.pbData,out.cbData);return result;}
 catch(...){SecureZeroMemory(out.pbData,out.cbData);throw;}
 }catch(const std::exception&x){napi_throw_error(e,x.what(),"Protected connector credential unavailable");return nullptr;}
}
NAPI_MODULE_INIT(){const char*names[]={"profile","enroll","readBound"};for(size_t i=0;i<3;i++){napi_value f;napi_create_function(env,names[i],NAPI_AUTO_LENGTH,invoke,(void*)i,&f);napi_set_named_property(env,exports,names[i],f);}return exports;}

#else
int wmain(int argc,wchar_t**argv){
 try{
 require(argc==3,"argument");Identity who;Chain c(argv[1],who);
 auto digest=hash(c.bytes);std::wstring binding=who.owner+L"|";
 for(auto&id:c.ids)binding+=id+L"|";
 binding+=std::wstring(digest.begin(),digest.end());
 require(binding==argv[2],"binding");DWORD flags;memcpy(&flags,c.bytes.data()+40,4);
 require(!(flags&CRYPTPROTECT_LOCAL_MACHINE),"machine-scope");
 DATA_BLOB in{(DWORD)c.bytes.size(),c.bytes.data()},out{};
 require(CryptUnprotectData(&in,nullptr,nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&out)!=0,"decrypt");
 Local plain;plain.p=out.pbData;
 try{require(out.cbData>=24&&out.cbData<=65536,"plaintext-size");
 for(DWORD i=0;i<out.cbData;i++)require(out.pbData[i]>=33&&out.pbData[i]<=126,"plaintext-format");
 c.recheck();_setmode(_fileno(stdout),_O_BINARY);
 require(fwrite(out.pbData,1,out.cbData,stdout)==out.cbData,"output");
 SecureZeroMemory(out.pbData,out.cbData);return 0;
 }catch(...){SecureZeroMemory(out.pbData,out.cbData);throw;}
 }catch(...){return 1;}
}
#endif
