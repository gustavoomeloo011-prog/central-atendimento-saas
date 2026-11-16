-- Preserve existing file types and data; add audio support to the private bucket.
update storage.buckets
set allowed_mime_types = case when allowed_mime_types is null then null else
  array(select distinct mime from unnest(allowed_mime_types || array['audio/mpeg','audio/mp4','audio/aac','audio/amr','audio/ogg']) as mime)
end
where id='chat-attachments';
