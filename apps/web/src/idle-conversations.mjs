// Uses message timestamps, never UI polling or conversation.updated_at.
export async function closeIdleConversations(db) {
  return db.transaction(async tx=>{
    const candidates=await tx.query(`select c.id,c.company_id from public.conversations c
      where c.status in ('waiting','open') and coalesce(
        (select max(m.created_at) from public.messages m where m.company_id=c.company_id and m.conversation_id=c.id
          and (m.direction='inbound' or (m.direction='outbound' and coalesce(m.delivery_status,'sent') not in ('failed','pending','unknown')))),c.created_at)
        < now()-interval '10 hours'
      order by c.created_at limit 100 for update of c skip locked`);
    let count=0;
    for(const c of candidates){
      // Recheck under the conversation lock in case a message arrived while selecting.
      const closed=await tx.one(`update public.conversations c set status='closed',assigned_profile_id=null,
        closed_at=now(),updated_at=now() where c.id=$1 and c.company_id=$2 and c.status in ('waiting','open')
        and coalesce((select max(m.created_at) from public.messages m where m.company_id=c.company_id and m.conversation_id=c.id
          and (m.direction='inbound' or (m.direction='outbound' and coalesce(m.delivery_status,'sent') not in ('failed','pending','unknown')))),c.created_at)
          < now()-interval '10 hours' returning c.id`,[c.id,c.company_id]);
      if(!closed)continue;
      await tx.query("update public.flow_runs set status='finished',updated_at=now() where company_id=$1 and conversation_id=$2",[c.company_id,c.id]);
      await tx.query("update public.messages set delivery_status='failed',error_message='Atendimento encerrado por inatividade.' where company_id=$1 and id in (select replace(idempotency_key,'meta-message:','') from public.whatsapp_outbox where company_id=$1 and conversation_id=$2 and status='pending')",[c.company_id,c.id]);
      await tx.query("update public.whatsapp_outbox set status='failed',last_error='Atendimento encerrado por inatividade.',updated_at=now() where company_id=$1 and conversation_id=$2 and status='pending'",[c.company_id,c.id]);
      await tx.query("insert into public.audit_events(id,company_id,action,entity_type,entity_id) values(gen_random_uuid()::text,$1,'conversation_closed_inactivity','conversation',$2)",[c.company_id,c.id]);
      count++;
    }
    return count;
  });
}

export function startIdleSweep(db,{onError=()=>{}}={}) {
  let running=false;
  const run=async()=>{if(running)return;running=true;try{await closeIdleConversations(db);}catch(error){onError(error);}finally{running=false;}};
  const timer=setInterval(run,60000);timer.unref();void run();
  return ()=>clearInterval(timer);
}
