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
  getState: () => ipcRenderer.invoke('app:state'),
  listInterfaces: () => ipcRenderer.invoke('artnet:interfaces'),
  rescanWled: () => ipcRenderer.invoke('wled:rescan'),
  setPreview: (interfaceId) => ipcRenderer.invoke('preview:set', interfaceId),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  saveMapping: (mapping) => ipcRenderer.invoke('mapping:save', mapping),
  deleteMapping: (id) => ipcRenderer.invoke('mapping:delete', id),
  setMappingEnabled: (id, enabled) => ipcRenderer.invoke('mapping:enable', id, enabled),
  openMonitor: (selection) => ipcRenderer.invoke('monitor:open', selection),
  onMonitorSelect: subscribe('monitor:select'),
  onFrames: subscribe('dmx:frames'),
  onStatus: subscribe('mapping:status'),
  onConfig: subscribe('config:changed'),
  onDevices: subscribe('wled:devices'),
});
