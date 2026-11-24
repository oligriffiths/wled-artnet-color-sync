// Exposes a small, explicit API to the sandboxed renderer.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.off(channel, listener);
    };
  };
}

contextBridge.exposeInMainWorld('bridge', {
  listInterfaces: () => ipcRenderer.invoke('artnet:interfaces'),
  listen: (config) => ipcRenderer.invoke('artnet:listen', config),
  rescanWled: () => ipcRenderer.invoke('wled:rescan'),
  startSending: (config) => ipcRenderer.invoke('send:start', config),
  stopSending: () => ipcRenderer.invoke('send:stop'),
  onDmx: subscribe('artnet:dmx'),
  onArtnetError: subscribe('artnet:error'),
  onDevices: subscribe('wled:devices'),
  onWledError: subscribe('wled:error'),
  onSent: subscribe('send:sent'),
});
