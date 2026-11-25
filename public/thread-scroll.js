// Keep a freshly opened chat at its latest message as history, fonts and images
// settle. Once the reader scrolls up, resizing must preserve their place.
export function followThreadBottom(thread) {
  let following = true;
  let lastHeight=thread.scrollHeight,lastViewport=thread.clientHeight,lastTop=thread.scrollTop;
  const remember=()=>{lastHeight=thread.scrollHeight;lastViewport=thread.clientHeight;lastTop=thread.scrollTop;};
  const bottom = () => {
    following = true;
    if (thread.isConnected) thread.scrollTop = thread.scrollHeight;
    remember();
  };
  const onScroll = () => {
    // WebKit can deliver a layout-induced scroll before ResizeObserver. Keep
    // following a growing/reflowed chat, but respect an actual move upward.
    const resized=lastHeight!==thread.scrollHeight||lastViewport!==thread.clientHeight;
    if(following&&resized&&thread.scrollTop>=lastTop-1){bottom();return;}
    following=thread.scrollHeight-thread.scrollTop-thread.clientHeight<32;
    remember();
  };
  thread.addEventListener('scroll', onScroll, {passive: true});
  const observer = new ResizeObserver(() => { if (following) bottom(); });
  observer.observe(thread);
  const inner = thread.querySelector('.thread-inner');
  if (inner) observer.observe(inner);
  return {bottom, get following() { return following; }, disconnect() { observer.disconnect(); thread.removeEventListener('scroll', onScroll); }};
}
