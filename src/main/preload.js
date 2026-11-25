const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  getCharacter: () => ipcRenderer.invoke('buddy:character'),
  onMood: callback => ipcRenderer.on('buddy:mood', (event, mood) => callback(mood)),
});