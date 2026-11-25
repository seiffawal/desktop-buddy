const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  getCharacter: () => ipcRenderer.invoke('buddy:character'),
  onMood: callback => ipcRenderer.on('buddy:mood', (event, mood) => callback(mood)),

  onBubbleShow: callback => ipcRenderer.on('bubble:show', (event, payload) => callback(payload)),
  onBubbleHide: callback => ipcRenderer.on('bubble:hide', () => callback()),
  expand: height => ipcRenderer.invoke('bubble:expand', height),
  collapse: () => ipcRenderer.invoke('bubble:collapse'),
  bubbleClosed: (id, action) => ipcRenderer.send('bubble:closed', { id, action }),
});