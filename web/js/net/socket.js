// WebSocket client with auto-reconnect + resume. Wire schema: docs/PROTOCOL.md §2.

export class Socket {
  #ws = null;
  #url;
  #handlers = new Map(); // type -> Set<fn>
  #sendQueue = [];
  #resumeId = null;
  #hello = null;
  #pingTimer = null;
  #closed = false;

  constructor(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) {
    this.#url = url;
  }

  connect(hello) {
    this.#hello = hello;
    this.#closed = false;
    this.#dial();
  }

  #dial() {
    if (this.#closed) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    ws.onopen = () => {
      const hello = { t: 'hello', proto: 1, ...this.#hello };
      if (this.#resumeId) hello.resume = this.#resumeId;
      ws.send(JSON.stringify(hello));
      for (const q of this.#sendQueue.splice(0)) ws.send(JSON.stringify(q));
      this.#pingTimer = setInterval(() => this.send({ t: 'ping' }), 15_000);
      this.#emit('_open', {});
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') this.#resumeId = msg.id;
      this.#emit(msg.t, msg);
    };
    ws.onclose = () => {
      clearInterval(this.#pingTimer);
      this.#emit('_close', {});
      if (!this.#closed) setTimeout(() => this.#dial(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  send(obj) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(obj));
    else if (obj.t !== 'ping') this.#sendQueue.push(obj);
  }

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.#handlers.get(type)?.delete(fn);
  }

  #emit(type, msg) {
    for (const fn of this.#handlers.get(type) ?? []) fn(msg);
    for (const fn of this.#handlers.get('*') ?? []) fn(msg);
  }

  close() {
    this.#closed = true;
    this.#ws?.close();
  }
}
