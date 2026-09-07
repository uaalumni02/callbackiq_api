let draining = false;
let voiceSnapshot = () => ({});
export const beginDrain = () => { draining = true; };
export const isDraining = () => draining;
export const registerVoiceSnapshot = (read) => { voiceSnapshot = read; };
export const getVoiceSnapshot = () => voiceSnapshot();
