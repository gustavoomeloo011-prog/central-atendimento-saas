const codePointLength = value => [...String(value || '')].length;

export function encodeFlowOptionRef(nodeId, optionId) {
  const node = String(nodeId || '');
  const option = String(optionId || '');
  if (!node || !option) throw new Error('Bloco e alternativa são obrigatórios.');
  return `flow:v1:${node.length}:${node}:${option}`;
}

export function decodeFlowOptionRef(value) {
  const raw = String(value || '');
  const match = /^flow:v1:(\d+):/.exec(raw);
  if (!match) return null;
  const length = Number(match[1]);
  const start = match[0].length;
  if (!Number.isSafeInteger(length) || length < 1 || length > 200 || start + length >= raw.length) return null;
  const nodeId = raw.slice(start, start + length);
  if (raw[start + length] !== ':') return null;
  const optionId = raw.slice(start + length + 1);
  return nodeId && optionId ? { kind: 'option', nodeId, optionId } : null;
}

export function parseMetaInbound(message = {}) {
  if (message.type === 'text') {
    const text = String(message.text?.body || '').trim();
    return text ? { kind: 'text', value: text, displayText: text } : null;
  }
  const button = message.interactive?.button_reply;
  const list = message.interactive?.list_reply;
  const templateButton = message.type === 'button' ? message.button : null;
  const actionId = String(button?.id || list?.id || templateButton?.payload || '').trim();
  const title = String(button?.title || list?.title || templateButton?.text || '').trim();
  if (actionId) {
    return { ...(decodeFlowOptionRef(actionId) || { kind: 'option', nodeId: '', optionId: actionId }), displayText: title || '[Opção selecionada]' };
  }
  if (message.type === 'interactive') return { kind: 'option', nodeId: '', optionId: '', displayText: title || '[Opção inválida]' };
  if (title) return { kind: 'text', value: title, displayText: title };
  return { kind: 'text', value: '', displayText: `[Mensagem ${String(message.type || 'não suportada')}]`, unsupported: true };
}

export function formatNumberedOptions(text, options = []) {
  const question = String(text || '').trim();
  if (!options.length) return question;
  return `${question}${question ? '\n\n' : ''}${options.map((option, index) => `${index + 1}. ${String(option.label || '')}`).join('\n')}`;
}

export function isInteractiveWindowExpired(payload = {}, now = Date.now()) {
  if (!Array.isArray(payload.options) || payload.options.length === 0) return false;
  const expiresAt = Date.parse(String(payload.windowExpiresAt || ''));
  return !Number.isFinite(expiresAt) || expiresAt <= Number(now);
}

export function buildMetaMessage(to, { text, options = [], nodeId = '', flowVersionId = '' } = {}) {
  const bodyText = String(text || '').trim();
  const items = Array.isArray(options) ? options.map(option => ({ id: String(option.id || ''), label: String(option.label || '').trim() })) : [];
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to || '') };
  if (!items.length) {
    if (!bodyText || codePointLength(bodyText) > 4096) throw new Error('A mensagem precisa ter entre 1 e 4096 caracteres.');
    return { mode: 'text', payload: { ...base, type: 'text', text: { preview_url: false, body: bodyText } } };
  }

  let reason = '';
  let useList = items.length >= 4;
  if (items.some(item => !item.id || !item.label || codePointLength(item.id) > 256)) reason = 'Cada alternativa precisa de identificador e rótulo válidos.';
  else if (items.some(item => codePointLength(encodeFlowOptionRef(nodeId, item.id)) > 256)) reason = 'O identificador da alternativa excede o limite aceito pela Meta.';
  else if (codePointLength(bodyText) > 1024) reason = 'O texto da pergunta excede o limite de uma mensagem interativa.';
  else if (items.length > 10) reason = 'A Meta aceita até 10 alternativas em uma lista; divida o menu em submenus.';
  else if (items.some(item => codePointLength(item.label) > 72)) reason = 'O texto de uma alternativa excede 72 caracteres.';

  // Button labels have a 20-character cap. Keep longer customer-facing labels
  // clickable by sending a list row with a short title and the complete label
  // as its description (Meta allows up to 72 characters there).
  if (!reason && items.length <= 3 && items.some(item => codePointLength(item.label) > 20)) useList = true;
  if (!reason && items.some(item => codePointLength(item.label) > 24)) useList = true;

  if (!reason && !useList) {
    return {
      mode: 'buttons',
      payload: {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: { buttons: items.map(item => ({ type: 'reply', reply: { id: encodeFlowOptionRef(nodeId, item.id), title: item.label } })) },
        },
      },
    };
  }
  if (!reason && items.length <= 10) {
    return {
      mode: 'list',
      payload: {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: 'Ver opções',
            sections: [{ title: 'Opções', rows: items.map((item,index) => ({
              id: encodeFlowOptionRef(nodeId, item.id),
              title: codePointLength(item.label) <= 24 ? item.label : `Opção ${index + 1}`,
              ...(codePointLength(item.label) > 24 ? { description: item.label } : {}),
            })) }],
          },
        },
      },
    };
  }

  const fallback = formatNumberedOptions(bodyText, items);
  if (!fallback || codePointLength(fallback) > 4096) throw new Error(reason || 'O menu excede o limite de texto da Cloud API.');
  return { mode: 'text-fallback', reason, payload: { ...base, type: 'text', text: { preview_url: false, body: fallback } } };
}
