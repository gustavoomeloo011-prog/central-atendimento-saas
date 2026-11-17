export function parseMetaEdit(message) {
  if(message?.type!=='edit')return null;
  const edit=message.edit;
  if(!edit?.original_message_id||edit.message?.type!=='text'||typeof edit.message.text?.body!=='string')return null;
  return {originalId:String(edit.original_message_id),body:edit.message.text.body,phone:String(message.from||'').replace(/\D/g,'')};
}

export async function applyStoredMetaEdit(db,company,originalId) {
  const event=await db.one(`select payload from public.connector_events where company_id=$1
    and event_type='meta.message' and payload->>'type'='edit'
    and payload->'edit'->>'original_message_id'=$2
    order by case when payload->>'timestamp' ~ '^[0-9]+$' then (payload->>'timestamp')::numeric else 0 end desc,processed_at desc limit 1`,[company,originalId]);
  const edit=parseMetaEdit(event?.payload);
  if(!edit?.phone)return false;
  const changed=await db.one(`update public.messages m set body=$3 from public.conversations c
    where m.company_id=$1 and m.provider_message_id=$2 and m.direction='inbound'
      and c.company_id=m.company_id and c.id=m.conversation_id and c.contact_phone=$4
    returning m.conversation_id`,[company,originalId,edit.body,edit.phone]);
  return Boolean(changed);
}

export async function recoverStoredMetaEdits(db) {
  const rows=await db.query("select distinct company_id,payload->'edit'->>'original_message_id' original_id from public.connector_events where event_type='meta.message' and payload->>'type'='edit'");
  for(const row of rows)if(row.original_id)await applyStoredMetaEdit(db,row.company_id,row.original_id);
}
