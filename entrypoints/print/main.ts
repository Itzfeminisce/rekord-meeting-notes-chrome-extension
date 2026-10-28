import { getMeeting, listMarkers, listNotes, listSegments } from '@/lib/db';
import { buildSections, dateLine, parseInclude } from '@/lib/export';

const root = document.getElementById('doc')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

async function render() {
  const params = new URLSearchParams(location.search);
  const id = params.get('meetingId');
  const meeting = id ? await getMeeting(id) : undefined;
  if (!id || !meeting) {
    root.replaceChildren(el('p', 'This meeting is no longer on this computer.', 'status'));
    return;
  }
  const [segments, notes, markers] = await Promise.all([listSegments(id), listNotes(id), listMarkers(id)]);
  document.title = meeting.title;
  const nodes: Node[] = [el('h1', meeting.title), el('p', dateLine(meeting), 'meta')];
  for (const sec of buildSections(meeting, segments, notes, markers, parseInclude(params.get('include')))) {
    nodes.push(el('h2', sec.heading));
    if (sec.list) {
      const ul = el('ul');
      sec.lines.forEach((l) => ul.append(el('li', l)));
      nodes.push(ul);
    } else {
      sec.lines.forEach((l) => nodes.push(el('p', l)));
    }
  }
  root.replaceChildren(...nodes);
  setTimeout(() => window.print(), 300);
}

render().catch(() => root.replaceChildren(el('p', 'Something went wrong while preparing this document.', 'status')));
