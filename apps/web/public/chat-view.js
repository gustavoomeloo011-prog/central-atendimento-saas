export function mediaKind(message) {
  const type=String(message.attachment_type||'').toLowerCase();
  for(const kind of ['image','audio','video'])if(type.startsWith(kind+'/'))return kind;
  const name=String(message.attachment_name||'').toLowerCase();
  if(/\.(png|jpe?g|webp|gif)$/.test(name)||/^\[Mensagem (image|sticker)\]$/.test(message.body||''))return 'image';
  if(/\.(mp3|m4a|ogg|opus|aac|amr)$/.test(name)||message.body==='[Mensagem audio]')return 'audio';
  if(/\.(mp4|3gp)$/.test(name)||message.body==='[Mensagem video]')return 'video';
  return 'document';
}

export function visibleMessageBody(message) {
  const body=String(message.body||'');
  return message.attachment_path&&/^\[Mensagem (audio|image|video|document|sticker)\]$/.test(body)?'':body;
}

export function captureScroll(element) {
  return {top:element.scrollTop,follow:element.scrollHeight-element.clientHeight-element.scrollTop<80};
}
export function restoreScroll(element,position) {
  element.scrollTop=!position||position.follow?element.scrollHeight:position.top;
}

// Only follow asynchronous media layout changes while the reader is at the end.
export function followMediaLayout(element) {
  const thread=element.closest('.messages');
  if(!thread)return;
  let following=captureScroll(thread).follow;
  const track=()=>{following=captureScroll(thread).follow;};
  thread.addEventListener('scroll',track,{passive:true});
  const done=()=>{thread.removeEventListener('scroll',track);if(following&&thread.isConnected)thread.scrollTop=thread.scrollHeight;};
  element.addEventListener(element.tagName==='IMG'?'load':'loadedmetadata',done,{once:true});
  element.addEventListener('error',done,{once:true});
}
