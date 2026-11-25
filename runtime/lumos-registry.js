// The running Lumos instance, for tools that act on it (lumos_reminder).
let instance=null;
export const setLumos=value=>{instance=value;};
export const getLumos=()=>instance;
