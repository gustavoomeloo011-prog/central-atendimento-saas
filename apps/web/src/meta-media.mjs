export function trustedMetaMediaUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || !/(^|\.)(facebook\.com|fbcdn\.net)$/.test(url.hostname) && url.hostname!=='lookaside.fbsbx.com') throw new Error('Endereço de mídia inválido.');
  return url;
}

export function validateAttachment(attachment) {
  const type = String(attachment?.type || '').split(';')[0].trim().toLowerCase();
  const extensions = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','application/pdf':'pdf','audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac','audio/amr':'amr','audio/ogg':'ogg'};
  if (!extensions[type]) throw Object.assign(new Error('Formato não permitido. Use imagem, PDF, MP4 ou áudio MP3, M4A, AAC, AMR ou OGG/Opus.'), {status:400});
  const bytes = Buffer.from(String(attachment.data || ''), 'base64');
  const limit = type.startsWith('image/') ? 5*1024*1024 : 10*1024*1024;
  if (!bytes.length || bytes.length > limit) throw Object.assign(new Error(`O anexo deve possuir no máximo ${limit/1024/1024} MB.`), {status:400});
  return {type, bytes, extension:extensions[type]};
}

export async function uploadMetaAttachment(attachment, {token, phoneNumberId, version, fetchImpl=fetch}) {
  const {type, bytes} = validateAttachment(attachment);
  const kind = type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : type==='image/webp' ? 'sticker' : type.startsWith('image/') ? 'image' : 'document';
  const form = new FormData();
  form.set('messaging_product','whatsapp');
  form.set('type',type);
  form.set('file',new Blob([bytes],{type}),String(attachment.name||'anexo'));
  const response = await fetchImpl(`https://graph.facebook.com/v${version}/${phoneNumberId}/media`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(20000)});
  const result = await response.json().catch(()=>({}));
  if (!response.ok || !result.id) throw Object.assign(new Error('A Meta recusou o upload do anexo.'), {status:502,metaCode:result.error?.code});
  return {kind, id:String(result.id), name:String(attachment.name||'anexo')};
}

export function mediaMessage(phone, media, text) {
  const item = {id:media.id};
  if (media.kind==='document') item.filename=media.name;
  if (text && ['image','video','document'].includes(media.kind)) item.caption=text;
  return {messaging_product:'whatsapp',recipient_type:'individual',to:phone,type:media.kind,[media.kind]:item};
}
