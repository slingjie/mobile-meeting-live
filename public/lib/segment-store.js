function appendText(previous, next) {
  const a = String(previous || '').trim();
  const b = String(next || '').trim();
  if (!a) return b;
  if (!b || a.endsWith(b)) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  return `${a}${/^[,，。.!！？?\s]/.test(b) ? '' : ' '}${b}`;
}

function addClockOffset(clock, offsetMs) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(clock || ''));
  if (!match) return String(clock || '');
  const baseSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const offsetSeconds = Math.trunc(Number(offsetMs || 0) / 1000);
  const total = (baseSeconds + offsetSeconds + 86400) % 86400;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

export class SegmentStore {
  constructor() {
    this.segments = [];
  }

  importEntries(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry?.id) continue;
      const verified = entry.status === 'final';
      if (entry.parentId && entry.speaker) {
        let parent = this.get(entry.parentId);
        if (!parent) {
          parent = {
            id: entry.parentId,
            time: addClockOffset(entry.time, -Number(entry.startMs || 0)),
            startedAt: null,
            sourceDraft: '',
            translationDraft: '',
            sourceFinal: '',
            translationFinal: '',
            status: verified ? 'final' : 'failed',
            error: verified ? '' : 'Persisted split final entry',
            utterances: [],
          };
          this.segments.push(parent);
        }
        if (parent.utterances.some(item => item.id === entry.id)) continue;
        parent.utterances.push({
          id: entry.id,
          startMs: Math.max(0, Math.round(Number(entry.startMs) || 0)),
          endMs: Math.max(0, Math.round(Number(entry.endMs) || 0)),
          speaker: /^S[1-6]$/.test(String(entry.speaker)) ? String(entry.speaker) : 'unknown',
          speakerEstimated: Boolean(entry.speakerEstimated),
          source: String(entry.text || ''),
          translation: String(entry.translation || ''),
          uncertain: Boolean(entry.uncertain),
        });
        parent.sourceFinal = parent.utterances.map(item => item.source).filter(Boolean).join('\n');
        parent.translationFinal = parent.utterances.map(item => item.translation).filter(Boolean).join('\n');
        continue;
      }
      if (this.get(entry.id)) continue;
      this.segments.push({
        id: entry.id,
        time: String(entry.time || ''),
        startedAt: null,
        sourceDraft: '',
        translationDraft: '',
        sourceFinal: String(entry.text || ''),
        translationFinal: String(entry.translation || ''),
        status: verified ? 'final' : 'failed',
        error: verified ? '' : 'Legacy live-only entry',
      });
    }
  }

  create({ id, time, startedAt }) {
    if (!id || this.get(id)) throw new Error('segment id must be unique');
    const segment = {
      id,
      time,
      startedAt,
      sourceDraft: '',
      translationDraft: '',
      sourceFinal: '',
      translationFinal: '',
      status: 'refining',
      error: '',
    };
    this.segments.push(segment);
    return segment;
  }

  get(id) {
    return this.segments.find(segment => segment.id === id);
  }

  appendDraft(id, { source = '', translation = '' }) {
    const segment = this.get(id);
    if (!segment) throw new Error(`unknown segment: ${id}`);
    if (segment.status === 'final') return segment;
    segment.sourceDraft = appendText(segment.sourceDraft, source);
    segment.translationDraft = appendText(segment.translationDraft, translation);
    return segment;
  }

  applyFinal(id, { source, translation }) {
    const segment = this.get(id);
    if (!segment) throw new Error(`unknown segment: ${id}`);
    segment.sourceFinal = String(source || '').trim();
    segment.translationFinal = String(translation || '').trim();
    segment.status = 'final';
    segment.error = '';
    return segment;
  }

  applyFinalUtterances(id, { utterances }) {
    const segment = this.get(id);
    if (!segment) throw new Error(`unknown segment: ${id}`);
    const rows = Array.isArray(utterances) ? utterances.filter(item => item?.source || item?.translation) : [];
    if (!rows.length) throw new Error('final utterances are required');
    segment.utterances = rows.map((item, index) => ({
      id: String(item.id || `${id}-u${index + 1}`),
      startMs: Math.max(0, Math.round(Number(item.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(item.endMs) || 0)),
      speaker: /^S[1-6]$/.test(String(item.speaker || '')) ? String(item.speaker) : 'unknown',
      speakerEstimated: true,
      source: String(item.source || '').trim(),
      translation: String(item.translation || '').trim(),
      uncertain: Boolean(item.uncertain),
    }));
    segment.sourceFinal = segment.utterances.map(item => item.source).filter(Boolean).join('\n');
    segment.translationFinal = segment.utterances.map(item => item.translation).filter(Boolean).join('\n');
    segment.status = 'final';
    segment.error = '';
    return segment;
  }

  markFailed(id, message) {
    const segment = this.get(id);
    if (!segment) throw new Error(`unknown segment: ${id}`);
    if (segment.status !== 'final') {
      segment.status = 'failed';
      segment.error = String(message || 'refinement failed');
    }
    return segment;
  }

  toEntries() {
    return this.segments.flatMap(segment => {
      if (Array.isArray(segment.utterances) && segment.utterances.length) {
        return segment.utterances.map(item => ({
          id: item.id,
          parentId: segment.id,
          time: addClockOffset(segment.time, item.startMs),
          text: item.source,
          translation: item.translation,
          status: segment.status,
          speaker: item.speaker,
          speakerEstimated: item.speakerEstimated,
          startMs: item.startMs,
          endMs: item.endMs,
          uncertain: item.uncertain,
        }));
      }
      return [{
        id: segment.id,
        time: segment.time,
        text: segment.sourceFinal || segment.sourceDraft,
        translation: segment.translationFinal || segment.translationDraft,
        status: segment.status,
      }];
    });
  }
}
