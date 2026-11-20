function getCollabServerUrl(): string {
  if (import.meta.env.VITE_COLLAB_SERVER_URL) {
    return import.meta.env.VITE_COLLAB_SERVER_URL;
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = window.location.hostname || 'localhost';
    return `${protocol}//${hostname}:1234`;
  }
  return 'ws://localhost:1234';
}

function getServerHttpUrl(): string {
  if (import.meta.env.VITE_SERVER_HTTP_URL) {
    return import.meta.env.VITE_SERVER_HTTP_URL;
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const hostname = window.location.hostname || 'localhost';
    return `${protocol}//${hostname}:1234`;
  }
  return 'http://localhost:1234';
}

export const config = {
  get collabServerUrl(): string {
    return getCollabServerUrl();
  },
  get serverHttpUrl(): string {
    return getServerHttpUrl();
  },
};
