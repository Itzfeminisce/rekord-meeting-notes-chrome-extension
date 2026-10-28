import { requestMic } from '@/lib/mic';

const title = document.getElementById('title')!;
const body = document.getElementById('body')!;

requestMic().then((ok) => {
  if (ok) {
    title.textContent = 'Microphone allowed';
    body.textContent = 'You can go back to Rekord. This tab will close.';
    setTimeout(() => window.close(), 1200);
  } else {
    title.textContent = 'Microphone blocked';
    body.textContent = 'Rekord could not use the microphone. Return to the side panel for how to fix it.';
  }
});
