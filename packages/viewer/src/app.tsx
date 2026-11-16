// The two screens: the list of maps (with a box to ask a new question), and a map with its panel and input bar. Moving
// between them doesn't reload the page.
import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError, api, connect, pageUrl, token } from './api';
import { Composer } from './composer';
import { Dock } from './dock';
import { ConversationButton } from './history';
import { MapGraph } from './graph';
import { Home } from './home';
import { navigate, usePath } from './nav';
import { StopButton, Stopped } from './stop';
import { Panel } from './panel';
import { PanelResizer, usePanelWidth } from './resize';
import { TourBubble } from './tour';
import { WIREFRAME_PANEL_W, firstScreen, screenOf } from './screen';
import { addedIds, currentView, initialState, reducer, selSize, visibleMap, type Sel } from './state';
import type { CheckReport } from './types';

export function App() {
  if (!token) {
    return (
      <main className="home">
        <h1>Open illuminate from its link</h1>
        <p className="muted lede">Use the link illuminate printed in your terminal (it ends in <code>?t=…</code>).</p>
      </main>
    );
  }
  return <Screens />;
}

function Screens() {
  const [stopped, setStopped] = useState(false);
  // Stopping closes the tab. Browsers only let a page close itself in some cases (a tab with one page of history), so
  // when that's refused the tab says illuminate stopped instead.
  const onStopped = useCallback(() => {
    window.close();
    setStopped(true);
  }, []);
  const path = usePath();
  if (stopped) return <Stopped />;
  const m = /^\/m\/([a-z0-9-]{1,80})\/?$/.exec(path);
  return m ? <MapScreen key={m[1]} mapId={m[1]!} onStopped={onStopped} /> : <Home onStopped={onStopped} />;
}

/** Every map in this repo, to jump between, with the current one showing. */
function MapSwitcher({ mapId, question }: { mapId: string; question: string }) {
  const [maps, setMaps] = useState<{ id: string; question: string; making?: boolean }[]>([]);
  useEffect(() => {
    api.list().then(
      (r) => setMaps([...r.making.map((x) => ({ ...x, making: true })), ...r.maps.map((x) => ({ id: x.id, question: x.question }))]),
      () => {},
    );
  }, [mapId]);
  const list = maps.some((x) => x.id === mapId) ? maps : [{ id: mapId, question }, ...maps];
  return (
    <select className="switcher" value={mapId} onChange={(e) => navigate(pageUrl(e.target.value))} aria-label="Switch to another map" title="Switch to another map in this repo">
      {list.map((x) => <option key={x.id} value={x.id}>{x.question || x.id}{x.making ? ' (being made)' : ''}</option>)}
    </select>
  );
}

/**
 * What the check found, in words, and no more than it found. The checker re-tests every box, arrow and gap against the
 * repo each time the map is shown: that proves each part is real code, not that the map is the whole story. Proposals
 * are counted apart, since they aren't claims about the code as it is.
 */
function MapStatus({ report }: { report: CheckReport | null }) {
  if (!report) return null;
  const off = report.summary.unconfirmed;
  const { pending, done } = report.summary.proposals ?? { pending: 0, done: 0 };
  const proposed = pending + done;
  const proposals = !proposed ? null : (
    <span className="map-status proposals" title="Parts of this map are a proposal, drawn in violet: they aren't in the code yet, or would change or go. illuminate checks the code to see which have been done.">
      {done === 0 ? `${proposed} proposed ${proposed === 1 ? 'change' : 'changes'}` : `${done} of ${proposed} proposed changes done`}
    </span>
  );
  const proposalsAndChanges = <>{proposals}<ChangeStatus report={report} /></>;
  if (!off) {
    return (
      <>
        <span className="map-status ok" title="Every box and arrow on this map was just re-checked and is really in the code, and every gap's search still finds nothing. That shows each part is real; it doesn't show the map covers everything.">✓ Every part is in the code</span>
        {proposalsAndChanges}
      </>
    );
  }
  return (
    <>
      <span
        className="map-status off"
        title="Every time the map is shown, illuminate re-checks it against the code. These parts no longer hold, usually because the code changed after the map was made. They're dashed and marked ? on the map; click one to see why."
      >
        {off === 1 ? '1 part of this map doesn’t match the code' : `${off} parts of this map don’t match the code`}
      </span>
      {proposalsAndChanges}
    </>
  );
}

/** On a map of a change: which commit the code is compared with, and how much on the map differs from it. */
function ChangeStatus({ report }: { report: CheckReport }) {
  const since = report.since;
  if (!since) return null;
  if (!since.commit) {
    return <span className="map-status off" title={`This map compares the code with "${since.ref}", but that isn't a commit in this repo, so nothing could be compared.`}>Can’t find the commit this map compares with</span>;
  }
  const { added, changed, removed } = report.summary.changes ?? { added: 0, changed: 0, removed: 0 };
  const when = since.date ? new Date(since.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const counts = [added && `${added} added`, changed && `${changed} changed`, removed && `${removed} removed`].filter(Boolean).join(' · ');
  return (
    <span
      className="map-status changes"
      title={`This map shows the code as it is now, compared with commit ${since.commit.slice(0, 7)}${since.subject ? ` ("${since.subject}")` : ''}. illuminate works out from the two versions which boxes and arrows are new, different or gone. It can't tell who made a change.`}
    >
      Changes since {since.commit.slice(0, 7)}{when ? ` (${when})` : ''}{counts ? `: ${counts}` : ': nothing on this map differs'}
    </span>
  );
}

function MapScreen({ mapId, onStopped }: { mapId: string; onStopped: () => void }) {
  const [s, dispatch] = useReducer(reducer, mapId, initialState);
  const [draft, setDraft] = useState('');
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const wasConnected = useRef(false);

  const load = useCallback(() => {
    api.get(mapId).then(
      (payload) => dispatch({ type: 'loaded', payload }),
      (e: Error) => dispatch(e instanceof ApiError && /No such map/.test(e.message) ? { type: 'missing' } : { type: 'error', message: e.message }),
    );
  }, [mapId]);

  useEffect(load, [load]);
  useEffect(
    () =>
      connect(
        (event) => dispatch({ type: 'event', event }),
        (value) => {
          dispatch({ type: 'connected', value });
          if (value && wasConnected.current === false && s.phase !== 'loading') load(); // catch up after a reconnect
          wasConnected.current = value;
        },
        onStopped,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q || s.job) return;
      api.ask(mapId, q, s.selection).then(() => setDraft(''), (e: Error) => dispatch({ type: 'error', message: e.message }));
    },
    [mapId, s.job, s.selection],
  );

  const onFix = (fixId: string, action: 'approve' | 'reject' | 'undo') => {
    if (action === 'approve') dispatch({ type: 'fixStatus', fixId, status: 'applying', problems: [] });
    api[action](mapId, fixId).catch((e: ApiError) => {
      if (action === 'approve') dispatch({ type: 'fixStatus', fixId, status: 'failed', problems: e.problems.length ? e.problems : [e.message] });
      else dispatch({ type: 'error', message: [e.message, ...e.problems].join(' ') });
    });
  };

  // A question about a different part of the app: make a new map for it (and go there), or answer it in words here.
  const onOffer = (answerId: string, choice: 'map' | 'words') => {
    api.offer(mapId, answerId, choice).then(
      (r) => { if (r.id) navigate(pageUrl(r.id)); },
      (e: Error) => dispatch({ type: 'error', message: e.message }),
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      // Esc steps back one level at a time: walkthrough, then selection, then the answer, to the whole map.
      if (e.key === 'Escape') {
        if (s.tour !== null) dispatch({ type: 'tour', stop: null });
        else if (selSize(s.selection)) dispatch({ type: 'clearSelection' });
        else dispatch({ type: 'overview' });
        return;
      }
      if (typing || s.tour === null) return;
      if (e.key === 'ArrowRight') dispatch({ type: 'tour', stop: s.tour + 1 });
      if (e.key === 'ArrowLeft') dispatch({ type: 'tour', stop: s.tour - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.tour, s.selection]);

  const shown = s.answers.find((a) => a.id === s.shown);
  const pendingFix = shown?.fix && ['proposed', 'applying', 'failed'].includes(s.fixes[shown.fix.id]?.status ?? '') ? shown.fix : null;
  const onSelect = useCallback((kind: keyof Sel, id: string, additive: boolean) => dispatch({ type: 'select', kind, id, additive }), []);
  const onClear = useCallback(() => dispatch({ type: 'clearSelection' }), []);
  const drawn = visibleMap(s);
  const added = addedIds(s);
  const view = currentView(s);
  const touring = !!s.map && s.tour !== null;
  // The panel shows only when it has something to say: an answer, what's selected, Claude's progress or an error
  // (before the map exists, it says how making it is going). Earlier questions are in the dock. During the walkthrough
  // it steps aside for the map, unless there is an error, Claude's progress, or a box the person picked to read about
  // (the next stop clears that pick, and the panel steps aside again).
  const hasPanel = !s.map || !!s.error || !!s.job || s.shown !== null || selSize(s.selection) > 0;
  const panel = hasPanel && (!touring || !!s.error || s.job?.kind === 'ask' || selSize(s.selection) > 0);
  // A page's wireframe needs room to keep the shape of a page. While one is showing, the walkthrough bubble is wider,
  // and the panel is at least wide enough for it (never narrower than the person set it, and the map keeps some room).
  const tourWide = touring && firstScreen(s.map!, s.report, s.map!.tour[s.tour!]?.focus.nodes ?? [])?.show.kind === 'wireframe';
  const picked = selSize(s.selection) === 1 ? s.selection.nodes[0] : undefined;
  const wirePanel = !!picked && screenOf(s.report, picked)?.kind === 'wireframe';
  const shownPanelWidth = wirePanel ? Math.max(panelWidth, Math.min(WIREFRAME_PANEL_W, window.innerWidth - 360)) : panelWidth;
  // One question box: at the bottom of the conversation while it's open, in the dock while it isn't.
  const askInPanel = panel && !!s.map;
  const composer = s.map ? (
    <Composer
      map={s.map}
      selection={s.selection}
      draft={draft}
      busy={!!s.job}
      autoFocus={askInPanel}
      onDraft={setDraft}
      onRemove={(kind, id) => dispatch({ type: 'select', kind, id, additive: true })}
      onSend={() => ask(draft)}
    />
  ) : null;

  return (
    // The map's camera (useReactFlow) needs the provider around it.
    <ReactFlowProvider>
    <div className="app">
      <header className="topbar">
        <a className="brand" href={pageUrl()} title="All maps in this repo"><i className="brand-mark" aria-hidden="true" />illuminate</a>
        <div className="topbar-map">
          {s.meta?.parent && <a className="crumb" href={pageUrl(s.meta.parent.mapId)} title={`Back to the map this one came from: ${s.meta.parent.question}`}>← {s.meta.parent.question}</a>}
          <MapSwitcher mapId={mapId} question={s.map?.question ?? s.job?.question ?? ''} />
        </div>
        <MapStatus report={s.report} />
        <a className="pill-btn" href={pageUrl()} title="Ask a new question and make a map for it">New map</a>
        <StopButton busy={!!s.job} onStopped={onStopped} onError={(message) => dispatch({ type: 'error', message })} />
        <span className={s.connected ? 'live on' : 'live'} title={s.connected ? 'Connected to illuminate' : 'Reconnecting to illuminate…'} />
      </header>
      <div className={panel ? 'body' : 'body full'} style={{ '--panel-w': `${shownPanelWidth}px` } as CSSProperties}>
        <div className="canvas">
          {s.map && drawn ? (
            <>
              <MapGraph map={drawn} report={s.report} selection={s.selection} view={view} fresh={s.fresh} added={added} ghost={pendingFix ?? null} touring={touring} tourWide={tourWide} onSelect={onSelect} onClear={onClear} />
              {!touring && !panel && <ConversationButton state={s} dispatch={dispatch} />}
              {touring && <TourBubble map={s.map} report={s.report} stop={s.tour!} onTour={(stop) => dispatch({ type: 'tour', stop })} onAsk={setDraft} />}
              <Dock map={s.map} tour={s.tour} onTour={(stop) => dispatch({ type: 'tour', stop })} selected={selSize(s.selection)}>
                {askInPanel ? null : composer}
              </Dock>
            </>
          ) : (
            <div className="empty">{s.phase === 'making' ? <div className="pulse">Claude is exploring the code…</div> : null}</div>
          )}
        </div>
        {panel && <PanelResizer width={shownPanelWidth} onWidth={setPanelWidth} />}
        {panel && <Panel state={s} dispatch={dispatch} onFix={onFix} onFocus={(id) => dispatch({ type: 'focus', id })} onOffer={onOffer} composer={askInPanel ? composer : null} />}
      </div>
    </div>
    </ReactFlowProvider>
  );
}
