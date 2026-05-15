document.addEventListener('alpine:init', () => {
  Alpine.data('tennisApp', () => ({
    // ======= STATE =======
    view: 'standings',
    // Player roster — bootstrapped from data.js PLAYERS, then overwritten by
    // server data.players on first /api/data fetch. Admin can append via
    // POST /api/players (addPlayer action). Adding a player auto-expands the
    // round-robin: recomputeDerived generates pair combinations from this list.
    players: PLAYERS.slice(),
    results: {},
    schedule: {},
    live: {},
    // Per-key timestamp of when a result was recorded. Used to show recent
    // matches on the standings page. Old (seeded) results have no entry here
    // and don't appear in the recent feed — that's intentional.
    resultsRecordedAt: {},
    passwordHash: null,
    isAdmin: false,

    matchSearch: '',
    matchFilter: 'scheduled',
    matchPlayerFilter: '',

    passwordInput: '',
    passwordError: '',

    // Admin: players management
    newPlayerName: '',
    addPlayerError: '',
    playersExpanded: false,
    playerSearch: '',
    // Inline player rename: editing state lives in the parent component so a
    // browser-level prompt() doesn't have to interrupt the flow. When set,
    // the matching row in the drawer renders an input + save/cancel buttons.
    playerEditing: null,
    playerEditValue: '',
    playerEditError: '',
    // Custom delete confirmation: shows match-count context (preventing the
    // "I didn't realize this would wipe 15 matches" footgun).
    playerDeleting: null,

    // Admin v2 UI: progressive disclosure state. The admin panel is
    // task-centric — only what the user needs RIGHT NOW is visible by
    // default; everything else lives behind explicit toggles.
    adminMenuOpen: false,         // ⋯ overflow menu (refresh/export/etc)
    adminPlayersOpen: false,      // players drawer (rare action, hidden)
    adminAboutOpen: false,        // backend mode + version detail sheet
    adminMatchActions: null,      // bottom sheet for secondary match actions
    adminFutureExpanded: false,   // collapsible "future matches" section
    adminPlayedExpanded: false,   // collapsible "played matches" section

    scoreMatch: null,
    scheduleMatch: null,
    scheduleInput: '',

    // Live scoring modal
    liveMatch: null,
    liveDraft: { sets: [], cur: [0, 0], tb: null },
    livePending: false,
    liveError: '',
    todayPicker: null,    // when set, shows "live or final?" chooser modal

    // Match finalization confirmation modal. Set when a tap would record a
    // 2nd-set victory (best of 3). User can confirm or cancel; cancel runs
    // the optional onCancel callback (e.g. to undo a TB increment).
    pendingFinalize: null,  // { setsA, setsB, winner, onConfirm, onCancel }

    wizard: {
      open: false,
      mode: 'schedule',
      step: 1,
      playerA: null,
      playerB: null,
      date: null,
      time: null,
      calMonth: null
    },

    timePresets: [
      '09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30',
      '13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
      '17:00','17:30','18:00','18:30','19:00','19:30','20:00'
    ],

    playerPicker: {
      open: false,
      title: 'Избери играч',
      showAll: true,
      callback: null
    },

    duelExpanded: null,
    duelSearch: '',
    // Whether the "Неизиграни" sub-section is expanded inside a duel card.
    // Per-player so opening it for one doesn't affect another.
    duelPendingExpanded: {},

    // Backend mode: 'api' (server) or 'local' (localStorage fallback)
    backendMode: 'local',
    saveStatus: '',  // '', 'saving', 'saved', 'error'
    apiBase: '/api',
    toast: '',
    _dataETag: null,
    _pollInterval: null,
    _fromServer: false,

    // Reactive "now" timestamp; bumped every 30s so time-based getters
    // (matchesShouldBeLive, etc.) reactively update without a full reload.
    _now: Date.now(),

    // Set to true when service worker has installed a new version in the
    // background. Shown as a tap-to-reload banner.
    swUpdateReady: false,

    // App version, read from sw.js CACHE_VERSION at boot.
    appVersion: '',

    // ===== Derived state (recomputed only when results/schedule change) =====
    matches: [],
    matchByPair: {},
    playedMatches: [],
    scheduledMatches: [],
    standings: [],

    // Web Push state. supported=false hides the UI button entirely (e.g. on
    // iOS Safari without PWA install). permission tracks the browser-level
    // grant; subscribed tracks whether we have an active server subscription.
    push: {
      supported: false,
      permission: 'default',
      subscribed: false,
      pending: false,
      endpoint: null,
      vapidKey: null
    },

    // ======= INIT =======
    async init() {
      await this.detectBackend();
      await this.load();
      this.recomputeDerived();
      this.loadAppVersion();
      this.initPush();

      // Auto-restore admin auth from localStorage. We prefer a session token
      // (rotated, server-revocable, no plaintext password on the wire). If
      // only the legacy password is present, we silently exchange it for a
      // token on first use and migrate the storage. Subsequent admin requests
      // get 401s if the token is invalid; onAdminUnauthorized() handles that.
      if (this.backendMode === 'api') {
        const savedToken = localStorage.getItem('tennis-admin-token');
        const legacyPass = localStorage.getItem('tennis-admin-pw');
        if (savedToken) {
          // Trust optimistically — first admin call will 401 if revoked/expired.
          this._adminToken = savedToken;
          this.isAdmin = true;
        } else if (legacyPass) {
          const result = await this.verifyApiPassword(legacyPass);
          if (result.kind === 'ok') {
            this._adminToken = result.token;
            localStorage.setItem('tennis-admin-token', result.token);
            localStorage.removeItem('tennis-admin-pw');
            this.isAdmin = true;
          } else if (result.kind === 'wrong') {
            localStorage.removeItem('tennis-admin-pw');
          }
          // 'error' (network) → keep legacy pw, retry next boot.
        }
      }

      // Persist + recompute on changes
      this.$watch('results', () => { this.recomputeDerived(); this.persist(); });
      this.$watch('schedule', () => { this.recomputeDerived(); this.persist(); });
      // Players list: server is the source of truth; client mutations come
      // through addPlayer (POST /api/players). Recompute matches/standings
      // when the list changes (e.g. a poll picked up a new addition).
      this.$watch('players', () => this.recomputeDerived());
      // Live state: localStorage only (server is updated via dedicated endpoint).
      // Without this, refreshing in local mode loses any in-progress live score.
      this.$watch('live', () => this.persistLocal());
      this.$watch('passwordHash', () => this.persistLocal());

      // Reset scroll on tab change
      this.$watch('view', () => window.scrollTo(0, 0));

      // Start polling for server-side changes
      this.startAutoRefresh();

      // Reactive "now" tick — bumps every 30s so getters that depend on
      // current time (matchesShouldBeLive, timeFromNow) re-evaluate.
      setInterval(() => { this._now = Date.now(); }, 30000);

      // Listen for service worker update readiness (dispatched from index.html).
      window.addEventListener('sw-update-available', () => {
        this.swUpdateReady = true;
        // Auto-reload after 30s for users who don't realise they should tap
        // the banner. Defer if they're in the middle of something (modal,
        // live scoring) — we don't want to interrupt active input.
        const tryAutoReload = () => {
          if (this.isUserBusy() || this.liveMatch) {
            setTimeout(tryAutoReload, 5000);
          } else {
            window.location.reload();
          }
        };
        setTimeout(tryAutoReload, 30000);
      });
    },

    async loadAppVersion() {
      const v = await this.fetchServerVersion();
      if (v) this.appVersion = v;
      // Belt-and-suspenders: poll every 60s for version mismatch. Catches the
      // edge case where SW lifecycle events (updatefound / controllerchange)
      // were missed for any reason (race, network blip, browser quirk). If
      // the running version differs from what the server now reports, surface
      // the update banner — the same one users get for SW-detected updates.
      setInterval(async () => {
        if (this.swUpdateReady || !this.appVersion) return;
        const current = await this.fetchServerVersion();
        if (current && current !== this.appVersion) this.swUpdateReady = true;
      }, 60 * 1000);
    },

    async fetchServerVersion() {
      // Prefer /api/version (canonical, ~80 bytes); fall back to parsing
      // sw.js for older deploys that don't expose the endpoint yet.
      try {
        const res = await fetch(this.apiBase + '/version', { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          if (j && typeof j.version === 'string' && j.version !== 'unknown') {
            return j.version;
          }
        }
      } catch (_) { /* fall through to sw.js */ }
      try {
        const res = await fetch('/sw.js', { cache: 'no-store' });
        if (!res.ok) return null;
        const text = await res.text();
        const m = text.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
        if (m && m[1] && m[1] !== '__CACHE_VERSION__') return m[1];
      } catch (_) { /* ignore */ }
      return null;
    },

    recomputeDerived() {
      // Build matches array as the round-robin combinations of the current
      // player list. Adding a player to `this.players` automatically appends
      // their new pairings to the end (preserving num for existing matches).
      const players = this.players;
      const matches = [];
      let num = 0;
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const p1 = players[i], p2 = players[j];
          const key = p1 + '|' + p2;
          const r = this.results[key];
          const sched = this.schedule[key];
          let s1 = null, s2 = null, played = false, winner = null, loser = null;
          if (r) {
            s1 = r[0]; s2 = r[1];
            played = true;
            if (s1 > s2) { winner = p1; loser = p2; }
            else { winner = p2; loser = p1; }
          }
          num++;
          matches.push({
            num, key, p1, p2,
            s1, s2, played, winner, loser,
            scheduledAt: sched || null
          });
        }
      }

      // Lookup map for O(1) matchBetween
      const byPair = {};
      for (const m of matches) {
        byPair[m.p1 + '|' + m.p2] = m;
        byPair[m.p2 + '|' + m.p1] = m;
      }

      const playedMatches = matches.filter(m => m.played);
      // Assign playNum: position in chronological order of being played.
      // Matches without recordedAt (legacy seeded results) come first in
      // their MATCHES_SEED order; new matches with recordedAt get the next
      // sequential numbers in timestamp order.
      const recAt = this.resultsRecordedAt || {};
      const playOrdered = [...playedMatches].sort((a, b) => {
        const ta = recAt[a.key] || '';
        const tb = recAt[b.key] || '';
        if (!ta && !tb) return a.num - b.num;       // both legacy → SEED order
        if (!ta) return -1;                          // legacy before timestamped
        if (!tb) return 1;
        return ta.localeCompare(tb);                 // both timestamped → chronological
      });
      playOrdered.forEach((m, i) => { m.playNum = i + 1; });
      matches.forEach(m => { if (m.playNum === undefined) m.playNum = null; });

      // ALL scheduled-but-unplayed matches (incl past dates). Admin views and
      // wizard shortcuts use this so past-scheduled matches are visible &
      // recordable. The Upcoming view filters via `activeScheduledMatches`.
      const scheduledMatches = matches
        .filter(m => !m.played && m.scheduledAt)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

      // Standings
      const stats = {};
      this.players.forEach(p => stats[p] = {
        name: p, played: 0, wins: 0, losses: 0,
        setsWon: 0, setsLost: 0, points: 0
      });
      for (const m of matches) {
        if (!m.played) continue;
        const a = stats[m.p1], b = stats[m.p2];
        a.played++; b.played++;
        a.setsWon += m.s1; a.setsLost += m.s2;
        b.setsWon += m.s2; b.setsLost += m.s1;
        if (m.winner === m.p1) { a.wins++; a.points++; b.losses++; }
        else { b.wins++; b.points++; a.losses++; }
      }
      const standings = Object.values(stats).sort((x, y) => {
        if (y.points !== x.points) return y.points - x.points;
        if (y.wins !== x.wins) return y.wins - x.wins;
        const dx = x.setsWon - x.setsLost;
        const dy = y.setsWon - y.setsLost;
        if (dy !== dx) return dy - dx;
        if (y.setsWon !== x.setsWon) return y.setsWon - x.setsWon;
        return x.name.localeCompare(y.name, 'bg');
      });
      // Stamp the global rank on each standings entry so filtered views (the
      // duels search) can still show "rank 7" instead of "rank 1 of filtered".
      standings.forEach((s, idx) => { s.rank = idx + 1; });

      this.matches = matches;
      this.matchByPair = byPair;
      this.playedMatches = playedMatches;
      this.scheduledMatches = scheduledMatches;
      this.standings = standings;
    },

    async detectBackend() {
      try {
        const r = await fetch(this.apiBase + '/health', { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          this.backendMode = 'api';
          this._serverHasAdmin = !!data.hasAdmin;
          return;
        }
      } catch (e) {}
      this.backendMode = 'local';
    },

    async load() {
      if (this.backendMode === 'api') {
        try {
          const r = await fetch(this.apiBase + '/data', { cache: 'no-store' });
          if (r.ok) {
            this._dataETag = r.headers.get('etag');
            const data = await r.json();
            this.results = data.results || {};
            this.schedule = data.schedule || {};
            this.live = data.live || {};
            this.resultsRecordedAt = data.resultsRecordedAt || {};
            if (Array.isArray(data.players) && data.players.length) this.players = data.players;

            // Recover live state where local is newer than server's
            // (e.g. user added a game but POST didn't reach server before refresh)
            this._recoverLocalLive();
            return;
          }
        } catch (e) {}
        // fall through to local
      }
      // localStorage path
      try {
        const raw = localStorage.getItem('tennis-v1');
        if (raw) {
          const data = JSON.parse(raw);
          this.results = data.results || {};
          this.schedule = data.schedule || {};
          this.live = data.live || {};
          this.resultsRecordedAt = data.resultsRecordedAt || {};
          if (Array.isArray(data.players) && data.players.length) this.players = data.players;
          this.passwordHash = data.passwordHash || null;
          return;
        }
      } catch (e) {}
      // First-run seed
      const r = {};
      MATCHES_SEED.forEach(([p1, p2, res]) => {
        if (res) r[p1 + '|' + p2] = res;
      });
      this.results = r;
      this.schedule = {};
      this.live = {};
      this.passwordHash = null;
      this.persistLocal();
    },

    persistLocal() {
      localStorage.setItem('tennis-v1', JSON.stringify({
        players: this.players,
        results: this.results,
        schedule: this.schedule,
        live: this.live,
        resultsRecordedAt: this.resultsRecordedAt,
        passwordHash: this.passwordHash
      }));
    },

    async persist() {
      // If state was just updated from server, skip writing it back
      if (this._fromServer) return;
      this.persistLocal();
      if (this.backendMode !== 'api') return;
      if (!this._adminToken) return;
      this.saveStatus = 'saving';
      try {
        const r = await fetch(this.apiBase + '/data', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': this._adminToken
          },
          body: JSON.stringify({
            results: this.results,
            schedule: this.schedule,
            live: this.live,
            resultsRecordedAt: this.resultsRecordedAt
          })
        });
        if (r.status === 401) { this._handleAdminUnauthorized(); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error('save failed: ' + r.status);
        // Update our ETag so the next poll won't think this is "new"
        const etag = r.headers.get('etag');
        if (etag) this._dataETag = etag;
        this.saveStatus = 'saved';
        setTimeout(() => { if (this.saveStatus === 'saved') this.saveStatus = ''; }, 2000);
      } catch (e) {
        this.saveStatus = 'error';
        console.error('[persist]', e);
      }
    },

    // ======= AUTO-REFRESH =======
    startAutoRefresh() {
      if (this.backendMode !== 'api') return;
      if (this._pollInterval) return;

      const tick = () => this.pollForUpdates();

      // Tick every 5s; poll() decides whether to actually fetch (5s when live, 25s otherwise)
      this._pollInterval = setInterval(() => {
        if (document.hidden) return;
        tick();
      }, 5000);

      // Refresh once on tab focus
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) tick();
      });
    },

    isUserBusy() {
      // Don't disturb if a modal/wizard is active.
      // Note: liveMatch is excluded — we WANT live data refreshes while scoring.
      return !!(this.scoreMatch || this.scheduleMatch ||
                this.wizard.open || this.playerPicker.open ||
                this.todayPicker || this.pendingFinalize ||
                this.saveStatus === 'saving');
    },

    get hasActiveLive() {
      for (const k in this.live) return true;
      return false;
    },

    async pollForUpdates() {
      if (this.isUserBusy()) return;
      // Throttle: 5s when a live match is active (or about to start), 10s
      // otherwise. Lower interval keeps viewers in sync with admin entries
      // without spamming the server (304s cost ~50 bytes each).
      const now = Date.now();
      const interval = (this.hasActiveLive || this.matchesShouldBeLive.length > 0) ? 5000 : 10000;
      if (this._lastPoll && (now - this._lastPoll) < interval - 100) return;
      this._lastPoll = now;
      try {
        const headers = {};
        if (this._dataETag) headers['If-None-Match'] = this._dataETag;
        const r = await fetch(this.apiBase + '/data', { headers, cache: 'no-store' });
        if (r.status === 304) return;       // no changes — zero body
        if (!r.ok) return;
        const newETag = r.headers.get('etag');
        const data = await r.json();

        // Server uses content-hash ETag, so a 200 here means content actually
        // changed. No need to diff every field — just snapshot live for the
        // toast distinction below.
        const oldLiveStr = JSON.stringify(this.live || {});

        // === Race protection for stale polls ===
        // Two failure modes a poll can introduce:
        //   1) It fetched state BEFORE our recent local write reached server,
        //      so server's response is missing entries we just wrote.
        //   2) It fetched state BEFORE our recent finalize, so server's
        //      response still has live[key] AND missing results[key].
        // Defense: keep any local entry whose timestamp is recent (3s window).
        const PROTECT_MS = 5000;

        // Results: protected by resultsRecordedAt timestamp.
        const serverResults = data.results || {};
        const serverRecorded = data.resultsRecordedAt || {};
        const mergedResults = { ...serverResults };
        const mergedRecorded = { ...serverRecorded };
        for (const k in (this.resultsRecordedAt || {})) {
          if (mergedResults[k]) continue;  // server has this — server wins
          const ts = this.resultsRecordedAt[k];
          if (!ts) continue;
          if (now - new Date(ts).getTime() < PROTECT_MS && this.results[k]) {
            mergedResults[k] = this.results[k];
            mergedRecorded[k] = ts;
          }
        }

        // Live: protected by _recentLocalLive timestamp + drop if results.
        const serverLive = data.live || {};
        const mergedLive = { ...serverLive };
        // If a result exists for the key (locally or server), the match is
        // over — drop any live entry for it.
        for (const k in mergedLive) {
          if (mergedResults[k]) delete mergedLive[k];
        }
        // Iterate over keys we recently wrote (added OR cleared). For each:
        //   - if result exists → drop from live (match finalized)
        //   - if local has entry → force into merged (server stale)
        //   - if local doesn't have entry → drop from merged (we cleared it)
        const recentLive = this._recentLocalLive || {};
        for (const k in recentLive) {
          if ((now - recentLive[k]) >= PROTECT_MS) continue;
          if (mergedResults[k]) { delete mergedLive[k]; continue; }
          if (this.live[k]) {
            mergedLive[k] = this.live[k];
          } else {
            delete mergedLive[k];
          }
        }

        this._fromServer = true;
        if (Array.isArray(data.players) && data.players.length) this.players = data.players;
        this.results = mergedResults;
        this.schedule = data.schedule || {};
        this.live = mergedLive;
        this.resultsRecordedAt = mergedRecorded;
        this._dataETag = newETag;
        // Clear flag after watchers fire (microtask)
        Promise.resolve().then(() => { this._fromServer = false; });

        const newLiveStr = JSON.stringify(this.live || {});

        // If we have a live modal open for a match that was finalized
        // externally (admin in another tab, server live auto-finalize, etc.),
        // close the modal so the user isn't tapping into thin air.
        if (this.liveMatch && this.results[this.liveMatch.key]) {
          this.closeLive();
          this.showToast('🏆 Мачът е финализиран');
        } else {
          this.showToast(newLiveStr !== oldLiveStr
            ? '🔴 Live резултат обновен'
            : '✨ Данните са обновени');
        }
      } catch (e) {
        // Silent fail — try again next tick
      }
    },

    showToast(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ''; }, 3000);
    },

    // Returns 'ok' | 'wrong' | 'error'.
    // Authenticates the password against the server and, on success, returns
    // a session token to be used in subsequent admin requests. Distinguishes
    // 'wrong' (confirmed bad password — wipe saved creds) from 'error' (server
    // unreachable / network blip — keep saved creds and try later).
    // Returns one of: { kind: 'ok', token }, { kind: 'wrong' }, { kind: 'error' }
    async verifyApiPassword(password) {
      try {
        const r = await fetch(this.apiBase + '/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j && typeof j.token === 'string' && j.token.length > 0) {
            return { kind: 'ok', token: j.token };
          }
          return { kind: 'error' };  // server said 200 but no token — odd
        }
        if (r.status === 401) return { kind: 'wrong' };
        return { kind: 'error' };
      } catch (e) {
        return { kind: 'error' };
      }
    },

    // ======= COMPUTED =======

    get filteredMatches() {
      const q = this.matchSearch.trim().toLowerCase();
      const player = this.matchPlayerFilter;
      return this.matches.filter(m => {
        if (this.matchFilter === 'played' && !m.played) return false;
        if (this.matchFilter === 'pending' && (m.played || m.scheduledAt)) return false;
        if (this.matchFilter === 'scheduled' && (m.played || !m.scheduledAt)) return false;
        if (player && m.p1 !== player && m.p2 !== player) return false;
        if (q && !m.p1.toLowerCase().includes(q) && !m.p2.toLowerCase().includes(q)) return false;
        return true;
      });
    },

    // For the admin "Изиграни" filter: group filteredMatches by recordedAt
    // day, newest first, with a trailing "По-рано" bucket for legacy entries.
    // Other filters return a single unlabeled group so the template stays uniform.
    get filteredMatchesGrouped() {
      const list = this.filteredMatches;
      if (this.matchFilter !== 'played') return [{ label: null, items: list }];

      const recAt = this.resultsRecordedAt || {};
      const withTs = [];
      const noTs = [];
      for (const m of list) {
        if (recAt[m.key]) withTs.push(m);
        else noTs.push(m);
      }
      withTs.sort((a, b) => recAt[b.key].localeCompare(recAt[a.key]));
      noTs.sort((a, b) => b.num - a.num);

      const todayStr = this.todayISO();
      const y = new Date(todayStr + 'T00:00:00');
      y.setDate(y.getDate() - 1);
      const yesterdayStr = this.toISODate(y);

      const groups = [];
      let cur = null;
      for (const m of withTs) {
        const ts = recAt[m.key];
        const d = ts.slice(0, 10);
        let label;
        if (d === todayStr) label = 'Днес';
        else if (d === yesterdayStr) label = 'Вчера';
        else label = new Date(ts).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
        if (!cur || cur.label !== label) {
          cur = { label, items: [] };
          groups.push(cur);
        }
        cur.items.push(m);
      }
      if (noTs.length) groups.push({ label: 'Без дата', items: noTs });
      return groups;
    },

    // Group matches by p1 (or flat list when a player is filtered).
    // Respects matchFilter: 'all' | 'played' | 'upcoming' | 'pending' | 'scheduled'
    get groupedMatches() {
      const q = this.matchSearch.trim().toLowerCase();
      const player = this.matchPlayerFilter;
      const filter = this.matchFilter;

      const matchPasses = m => {
        if (filter === 'played' && !m.played) return false;
        if (filter === 'upcoming' && m.played) return false;
        if (filter === 'pending' && (m.played || m.scheduledAt)) return false;
        if (filter === 'scheduled' && (m.played || !m.scheduledAt)) return false;
        if (q && !m.p1.toLowerCase().includes(q) && !m.p2.toLowerCase().includes(q)) return false;
        return true;
      };

      if (player) {
        const list = this.matches.filter(m =>
          (m.p1 === player || m.p2 === player) && matchPasses(m)
        );
        return [{ player, matches: list, isFiltered: true }];
      }

      // Each match has TWO players. Both players' groups should contain it,
      // otherwise the player listed second in MATCHES_SEED has 0 matches in
      // their card while the first has 19 (and everyone in between
      // monotonically less). Push to both groups for symmetry.
      const groups = {};
      this.players.forEach(p => groups[p] = []);
      this.matches.forEach(m => {
        if (!matchPasses(m)) return;
        groups[m.p1].push(m);
        groups[m.p2].push(m);
      });
      return this.players
        .filter(p => groups[p].length > 0)
        .map(p => ({ player: p, matches: groups[p], isFiltered: false }));
    },

    openPlayerPicker(callback, opts) {
      opts = opts || {};
      this.playerPicker.title = opts.title || 'Избери играч';
      this.playerPicker.showAll = opts.showAll !== false;
      this.playerPicker.callback = callback;
      this.playerPicker.open = true;
    },

    closePlayerPicker() {
      this.playerPicker.open = false;
      this.playerPicker.callback = null;
    },

    selectPickerPlayer(name) {
      const cb = this.playerPicker.callback;
      this.closePlayerPicker();
      if (cb) cb(name);
    },

    matchCountFor(player) {
      return this.matches.filter(m => m.p1 === player || m.p2 === player).length;
    },

    playedCountFor(player) {
      return this.matches.filter(m => (m.p1 === player || m.p2 === player) && m.played).length;
    },

    // ======= H2H GRID =======
    matchBetween(a, b) {
      return this.matchByPair[a + '|' + b] || null;
    },

    cellClass(rowP, colP) {
      if (rowP === colP) return 'cell-self';
      const m = this.matchBetween(rowP, colP);
      if (!m || !m.played) return 'cell-pending';
      const rowSets = m.p1 === rowP ? m.s1 : m.s2;
      const colSets = m.p1 === rowP ? m.s2 : m.s1;
      return rowSets > colSets ? 'cell-win' : 'cell-loss';
    },

    cellText(rowP, colP) {
      if (rowP === colP) return '—';
      const m = this.matchBetween(rowP, colP);
      if (!m || !m.played) return '';
      const rowSets = m.p1 === rowP ? m.s1 : m.s2;
      const colSets = m.p1 === rowP ? m.s2 : m.s1;
      return rowSets + ':' + colSets;
    },

    get needsPasswordSetup() {
      return this.backendMode === 'local' && !this.passwordHash;
    },

    playerStats(name) {
      return this.standings.find(s => s.name === name) || null;
    },

    playerPoints(name) {
      const s = this.playerStats(name);
      return s ? s.points : 0;
    },

    duelRowClass(p, op) {
      const m = this.matchBetween(p, op);
      if (!m) return 'duel-pending';
      if (!m.played) return m.scheduledAt ? 'duel-scheduled' : 'duel-pending';
      return m.winner === p ? 'duel-win' : 'duel-loss';
    },

    duelRowText(p, op) {
      const m = this.matchBetween(p, op);
      if (!m) return '—';
      if (!m.played) {
        if (m.scheduledAt) {
          const rel = this.dateRelative(m.scheduledAt);
          return rel || '📅';
        }
        return '—';
      }
      const pSets = m.p1 === p ? m.s1 : m.s2;
      const opSets = m.p1 === p ? m.s2 : m.s1;
      return pSets + ':' + opSets;
    },

    // Filtered standings for the duels view. Search is case-insensitive,
    // matches start-of-name first then substring (helps "Иво" not get drowned
    // by "Жоро Иванов" matches).
    get duelsList() {
      const q = (this.duelSearch || '').trim().toLowerCase();
      if (!q) return this.standings;
      return this.standings.filter(s => s.name.toLowerCase().includes(q));
    },

    // Standings split into "active" (played ≥ 1) and "inactive" (0 played).
    // Inactive players are visually de-emphasized and shown under a
    // separator at the bottom — same pattern as the duels view. Search
    // applies to both lists so a typed query filters everything.
    get standingsActive() {
      const q = (this.duelSearch || '').trim().toLowerCase();
      const list = this.standings.filter(s => s.played > 0);
      return q ? list.filter(s => s.name.toLowerCase().includes(q)) : list;
    },
    get standingsInactive() {
      const q = (this.duelSearch || '').trim().toLowerCase();
      const list = this.standings.filter(s => !s.played);
      const sorted = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'bg'));
      return q ? sorted.filter(s => s.name.toLowerCase().includes(q)) : sorted;
    },

    // Group opponents by status for the expanded card. Sorted within each
    // bucket by name. Pending bucket is collapsible to keep the card tight.
    duelOpponentsGrouped(p) {
      const wins = [], losses = [], scheduled = [], pending = [];
      for (const op of this.players) {
        if (op === p) continue;
        const m = this.matchBetween(p, op);
        if (m && m.played) {
          (m.winner === p ? wins : losses).push(op);
        } else if (m && m.scheduledAt) {
          scheduled.push(op);
        } else {
          pending.push(op);
        }
      }
      const byName = (a, b) => a.localeCompare(b, 'bg');
      wins.sort(byName); losses.sort(byName);
      scheduled.sort(byName); pending.sort(byName);
      return { wins, losses, scheduled, pending };
    },

    // Win rate as 0..1 — kept for any future use, but the duels view now
    // surfaces "match completion progress" (matches played out of total
    // possible) which is more meaningful early in a round-robin: small-sample
    // win rates are noisy, while progress is fair across all players.
    duelWinRate(s) {
      if (!s || !s.played) return null;
      return s.wins / s.played;
    },

    // Match-completion rate: 0..1 = (played / total possible). Total possible
    // is players.length - 1 (round-robin: everyone plays everyone once).
    duelProgressRate(s) {
      if (!s) return 0;
      const total = Math.max(1, this.players.length - 1);
      return Math.min(1, s.played / total);
    },

    // "5 / 19" — for the bar title.
    duelProgressLabel(s) {
      if (!s) return '';
      const total = Math.max(0, this.players.length - 1);
      return `${s.played} / ${total}`;
    },

    // 'gold' | 'silver' | 'bronze' | null — based on ranking position.
    // Only awarded if the player has played at least one match (otherwise a
    // 0-0 player at the top of the list would get a podium accent for nothing).
    duelPodium(s, idx) {
      if (!s || !s.played) return null;
      if (idx === 0) return 'gold';
      if (idx === 1) return 'silver';
      if (idx === 2) return 'bronze';
      return null;
    },

    duelOpponents(p) {
      // Sort: played wins first, then losses, then scheduled, then pending
      return this.players
        .filter(x => x !== p)
        .sort((a, b) => {
          const ma = this.matchBetween(p, a);
          const mb = this.matchBetween(p, b);
          const rank = m => {
            if (!m) return 4;
            if (!m.played) return m.scheduledAt ? 2 : 3;
            return m.winner === p ? 0 : 1;
          };
          const ra = rank(ma), rb = rank(mb);
          if (ra !== rb) return ra - rb;
          return a.localeCompare(b, 'bg');
        });
    },

    h2hRowSummary(rowP) {
      let wins = 0, losses = 0;
      this.players.forEach(colP => {
        if (rowP === colP) return;
        const m = this.matchBetween(rowP, colP);
        if (!m || !m.played) return;
        if (m.winner === rowP) wins++;
        else losses++;
      });
      return { wins, losses };
    },

    cellTitle(rowP, colP) {
      if (rowP === colP) return '';
      const m = this.matchBetween(rowP, colP);
      if (!m) return '';
      if (m.played) {
        const rowSets = m.p1 === rowP ? m.s1 : m.s2;
        const colSets = m.p1 === rowP ? m.s2 : m.s1;
        return `${rowP} ${rowSets}:${colSets} ${colP}`;
      }
      if (m.scheduledAt) return `Планиран: ${this.formatDate(m.scheduledAt)}`;
      return `${rowP} vs ${colP}`;
    },

    // ======= ADMIN ACTIONS =======
    // Append a new player to the roster. Admin-only.
    // - api mode: POST /api/players, server appends + persists, returns full
    //   list. Client takes the response as authoritative.
    // - local mode: just append locally; persistLocal will pick it up via the
    //   players watcher (no server to talk to).
    async addPlayer(rawName) {
      const name = (rawName || '').trim();
      if (!name) return { ok: false, error: 'Името е задължително' };
      if (name.length > 40) return { ok: false, error: 'Името е твърде дълго' };
      if (name.includes('|')) return { ok: false, error: 'Името не може да съдържа "|"' };
      if (this.players.includes(name)) return { ok: false, error: 'Играчът вече съществува' };

      if (this.backendMode === 'api') {
        if (!this._adminToken) return { ok: false, error: 'Необходима е админ парола' };
        try {
          const r = await fetch(this.apiBase + '/players', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': this._adminToken },
            body: JSON.stringify({ name })
          });
          const data = await r.json().catch(() => ({}));
          if (r.status === 401) { this._handleAdminUnauthorized(); return { ok: false, error: 'Сесията изтече' }; }
          if (!r.ok) return { ok: false, error: data.error || 'Грешка при запис' };
          this.players = data.players;
          this.showToast('✓ Добавен: ' + name);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: 'Мрежова грешка' };
        }
      }
      // local mode
      this.players = [...this.players, name];
      this.persistLocal();
      this.showToast('✓ Добавен: ' + name);
      return { ok: true };
    },

    // Rename a player. Admin-only. Server migrates all match keys atomically.
    async renamePlayer(oldName, rawNew) {
      const newName = (rawNew || '').trim();
      if (!newName) return { ok: false, error: 'Името е задължително' };
      if (newName.length > 40) return { ok: false, error: 'Името е твърде дълго' };
      if (newName.includes('|')) return { ok: false, error: 'Името не може да съдържа "|"' };
      if (newName === oldName) return { ok: true };
      if (this.players.includes(newName)) return { ok: false, error: 'Име вече съществува' };

      if (this.backendMode === 'api') {
        if (!this._adminToken) return { ok: false, error: 'Необходима е админ парола' };
        try {
          const r = await fetch(this.apiBase + '/players/' + encodeURIComponent(oldName), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': this._adminToken },
            body: JSON.stringify({ name: newName })
          });
          const data = await r.json().catch(() => ({}));
          if (r.status === 401) { this._handleAdminUnauthorized(); return { ok: false, error: 'Сесията изтече' }; }
          if (!r.ok) return { ok: false, error: data.error || 'Грешка при запис' };
          // Server migrated keys; pull fresh state so client mirrors it
          // exactly rather than re-doing the migration locally.
          await this._refetchAll();
          this.showToast('✓ Преименуван: ' + newName);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: 'Мрежова грешка' };
        }
      }

      // Local mode: do the same migration in-memory.
      this._renamePlayerLocal(oldName, newName);
      this.showToast('✓ Преименуван: ' + newName);
      return { ok: true };
    },

    _renamePlayerLocal(oldName, newName) {
      const renameKey = (k) => {
        const [a, b] = k.split('|');
        if (a === oldName) return newName + '|' + b;
        if (b === oldName) return a + '|' + newName;
        return k;
      };
      const remap = (obj) => {
        const out = {};
        for (const k in obj) out[renameKey(k)] = obj[k];
        return out;
      };
      this._fromServer = true;  // suppress the persist watcher; we'll persist explicitly
      this.players = this.players.map(p => p === oldName ? newName : p);
      this.results = remap(this.results);
      this.schedule = remap(this.schedule);
      this.live = remap(this.live);
      this.resultsRecordedAt = remap(this.resultsRecordedAt);
      this.persistLocal();
      Promise.resolve().then(() => { this._fromServer = false; });
    },

    // Delete a player + all matches involving them. Admin-only. Lossy.
    async deletePlayer(name) {
      if (this.players.length <= 2) return { ok: false, error: 'Трябват поне 2 играчи' };
      if (!this.players.includes(name)) return { ok: false, error: 'Няма такъв играч' };

      if (this.backendMode === 'api') {
        if (!this._adminToken) return { ok: false, error: 'Необходима е админ парола' };
        try {
          const r = await fetch(this.apiBase + '/players/' + encodeURIComponent(name), {
            method: 'DELETE',
            headers: { 'X-Admin-Token': this._adminToken }
          });
          const data = await r.json().catch(() => ({}));
          if (r.status === 401) { this._handleAdminUnauthorized(); return { ok: false, error: 'Сесията изтече' }; }
          if (!r.ok) return { ok: false, error: data.error || 'Грешка при запис' };
          await this._refetchAll();
          this.showToast('✓ Изтрит: ' + name);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: 'Мрежова грешка' };
        }
      }

      // Local mode
      this._deletePlayerLocal(name);
      this.showToast('✓ Изтрит: ' + name);
      return { ok: true };
    },

    _deletePlayerLocal(name) {
      const involves = (k) => {
        const [a, b] = k.split('|');
        return a === name || b === name;
      };
      const filterKeys = (obj) => {
        const out = {};
        for (const k in obj) if (!involves(k)) out[k] = obj[k];
        return out;
      };
      this._fromServer = true;
      this.players = this.players.filter(p => p !== name);
      this.results = filterKeys(this.results);
      this.schedule = filterKeys(this.schedule);
      this.live = filterKeys(this.live);
      this.resultsRecordedAt = filterKeys(this.resultsRecordedAt);
      this.persistLocal();
      Promise.resolve().then(() => { this._fromServer = false; });
    },

    // After a server-side mutation that rewrote keys (rename/delete), pull
    // the canonical state so the client doesn't re-do migration logic and
    // risk drift. Sets _fromServer so the watcher doesn't persist back.
    async _refetchAll() {
      try {
        const r = await fetch(this.apiBase + '/data', { cache: 'no-store' });
        if (!r.ok) return;
        this._dataETag = r.headers.get('etag');
        const data = await r.json();
        this._fromServer = true;
        if (Array.isArray(data.players) && data.players.length) this.players = data.players;
        this.results = data.results || {};
        this.schedule = data.schedule || {};
        this.live = data.live || {};
        this.resultsRecordedAt = data.resultsRecordedAt || {};
        Promise.resolve().then(() => { this._fromServer = false; });
      } catch (e) {}
    },

    setResult(match, s1, s2) {
      const newResults = { ...this.results };
      newResults[match.key] = [s1, s2];
      this.results = newResults;
      // Stamp recordedAt so this shows up in "recent results". For non-admin
      // path the server overrides with its own timestamp on next poll —
      // local stamp is just for instant UI feedback.
      const newRecorded = { ...this.resultsRecordedAt };
      newRecorded[match.key] = new Date().toISOString();
      this.resultsRecordedAt = newRecorded;
      if (this.schedule[match.key]) {
        const newSchedule = { ...this.schedule };
        delete newSchedule[match.key];
        this.schedule = newSchedule;
      }
      // Drop any in-progress live state for this match — it's now finalized.
      if (this.live[match.key]) {
        const newLive = { ...this.live };
        delete newLive[match.key];
        this.live = newLive;
      }
      this.scoreMatch = null;

      // Non-admin on match day: persist() will bail (no admin pwd).
      // Use the dedicated endpoint instead so the result reaches the server.
      if (this.backendMode === 'api' && !this._adminToken) {
        this._submitResultRemote(match, s1, s2);
      }
    },

    async _submitResultRemote(match, s1, s2) {
      try {
        const r = await fetch(this.apiBase + '/match/' + encodeURIComponent(match.key) + '/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ s1, s2 })
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          this.showToast('⚠️ ' + (data.error || 'Грешка при запис'));
          return;
        }
        this.showToast('🏆 Резултат записан');
      } catch (e) {
        this.showToast('⚠️ Мрежова грешка');
      }
    },

    clearResult(match) {
      const newResults = { ...this.results };
      delete newResults[match.key];
      this.results = newResults;
      const newRecorded = { ...this.resultsRecordedAt };
      delete newRecorded[match.key];
      this.resultsRecordedAt = newRecorded;
    },

    setSchedule(match, isoString) {
      if (!isoString) return;
      const newSchedule = { ...this.schedule };
      newSchedule[match.key] = isoString;
      this.schedule = newSchedule;
      this.scheduleMatch = null;
      this.scheduleInput = '';
    },

    clearSchedule(match) {
      const newSchedule = { ...this.schedule };
      delete newSchedule[match.key];
      this.schedule = newSchedule;
    },

    openScore(match) { this.scoreMatch = match; },
    openSchedule(match) {
      this.scheduleMatch = match;
      this.scheduleInput = match.scheduledAt || '';
    },

    // ======= WIZARD =======
    openWizard(mode) {
      const today = new Date();
      this.wizard = {
        open: true,
        mode,
        step: 1,
        playerA: null,
        playerB: null,
        date: null,
        time: null,
        calMonth: new Date(today.getFullYear(), today.getMonth(), 1)
      };
    },

    closeWizard() {
      this.wizard.open = false;
    },

    wizardBack() {
      if (this.wizard.step > 1) this.wizard.step--;
    },

    wizardSelectA(p) {
      this.wizard.playerA = p;
      this.wizard.step = 2;
    },

    // Quick pick: skip player selection — both players known from scheduled match
    wizardPickScheduledForResult(match) {
      this.wizard.playerA = match.p1;
      this.wizard.playerB = match.p2;
      this.wizard.step = 3;
    },

    wizardSelectB(p) {
      this.wizard.playerB = p;
      // Pre-fill with existing schedule if present
      const m = this.matchBetween(this.wizard.playerA, p);
      if (m && m.scheduledAt && this.wizard.mode === 'schedule') {
        const [d, t] = m.scheduledAt.split('T');
        this.wizard.date = d;
        this.wizard.time = t || '18:00';
      }
      this.wizard.step = 3;
    },

    wizardSelectDate(iso) {
      this.wizard.date = iso;
      this.wizard.step = 4;
    },

    get wizardOpponents() {
      const a = this.wizard.playerA;
      if (!a) return [];
      return this.players
        .filter(p => p !== a)
        .map(p => {
          const m = this.matchBetween(a, p);
          return {
            name: p,
            played: m ? m.played : false,
            scheduledAt: m ? m.scheduledAt : null
          };
        })
        .filter(op => !op.played) // hide already played
        .sort((x, y) => {
          // scheduled first
          if (x.scheduledAt && !y.scheduledAt) return -1;
          if (!x.scheduledAt && y.scheduledAt) return 1;
          return x.name.localeCompare(y.name, 'bg');
        });
    },

    get wizardTitle() {
      const m = this.wizard.mode;
      const s = this.wizard.step;
      if (s === 1) return m === 'schedule' ? 'Кой ще играе?' : 'Кой играч?';
      if (s === 2) return 'Срещу кого?';
      if (s === 3 && m === 'schedule') return 'Кога?';
      if (s === 3 && m === 'result') return 'Какъв е резултатът?';
      if (s === 4 && m === 'schedule') return 'В колко часа?';
      return '';
    },

    get wizardConfirmDateText() {
      if (!this.wizard.date) return '';
      const date = this.wizard.date;
      const time = this.wizard.time || '00:00';
      return this.formatDateLong(date + 'T' + time);
    },

    wizardConfirmSchedule() {
      const a = this.wizard.playerA;
      const b = this.wizard.playerB;
      const date = this.wizard.date;
      const time = this.wizard.time;
      if (!a || !b || !date || !time) return;
      const m = this.matchBetween(a, b);
      if (!m) return;
      this.setSchedule(m, date + 'T' + time);
      this.closeWizard();
      // Switch to upcoming view to show what was scheduled
      this.view = 'upcoming';
    },

    wizardConfirmResult(s1, s2) {
      const a = this.wizard.playerA;
      const b = this.wizard.playerB;
      if (!a || !b) return;
      const m = this.matchBetween(a, b);
      if (!m) return;
      // Order of s1/s2 follows wizard.playerA
      const finalS1 = m.p1 === a ? s1 : s2;
      const finalS2 = m.p1 === a ? s2 : s1;
      this.setResult(m, finalS1, finalS2);
      this.closeWizard();
    },

    // ======= CALENDAR =======
    get calendarMonthLabel() {
      const d = this.wizard.calMonth;
      if (!d) return '';
      const months = ['януари','февруари','март','април','май','юни',
                      'юли','август','септември','октомври','ноември','декември'];
      return months[d.getMonth()] + ' ' + d.getFullYear();
    },

    get calendarDays() {
      const d = this.wizard.calMonth;
      if (!d) return [];
      const year = d.getFullYear();
      const month = d.getMonth();
      const first = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0).getDate();

      // Mon=0
      let dow = first.getDay();
      dow = (dow + 6) % 7;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const days = [];
      for (let i = dow - 1; i >= 0; i--) {
        const date = new Date(year, month, -i);
        days.push(this.calDayObj(date, today, true));
      }
      for (let i = 1; i <= lastDay; i++) {
        const date = new Date(year, month, i);
        days.push(this.calDayObj(date, today, false));
      }
      while (days.length < 42) {
        const last = days[days.length - 1];
        const lastDate = new Date(last.year, last.monthIdx, last.day + 1);
        days.push(this.calDayObj(lastDate, today, true));
      }
      return days;
    },

    calDayObj(date, today, isOtherMonth) {
      const iso = this.toISODate(date);
      const hasMatches = this.scheduledMatches.some(m => m.scheduledAt.startsWith(iso));
      return {
        date: iso,
        day: date.getDate(),
        year: date.getFullYear(),
        monthIdx: date.getMonth(),
        isOtherMonth,
        isPast: date < today,
        isToday: date.getTime() === today.getTime(),
        hasMatches
      };
    },

    calPrevMonth() {
      const d = this.wizard.calMonth;
      this.wizard.calMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    },

    calNextMonth() {
      const d = this.wizard.calMonth;
      this.wizard.calMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    },

    toISODate(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    },

    // ======= PASSWORD =======
    async hashPassword(pw) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Ask the browser's password manager to offer to save credentials.
    // Uses the Credential Management API (Chromium + recent Safari/Firefox).
    // SPAs need this because @submit.prevent blocks the form submission and
    // browsers' "user just logged in" heuristics never trigger otherwise.
    // Wrapped — never let a credential-store hiccup break login.
    async _offerSaveCredential(formEl) {
      try {
        if (typeof PasswordCredential !== 'function' || !formEl) return;
        const cred = new PasswordCredential(formEl);
        await navigator.credentials.store(cred);
      } catch (e) { /* user dismissed, browser unsupported, or insecure context */ }
    },

    async submitPassword(formEl) {
      this.passwordError = '';
      if (!this.passwordInput || this.passwordInput.length < 4) {
        this.passwordError = 'Минимум 4 символа';
        return;
      }

      // API mode — verify against server, get session token in return.
      if (this.backendMode === 'api') {
        const result = await this.verifyApiPassword(this.passwordInput);
        if (result.kind === 'wrong') {
          this.passwordError = 'Грешна парола';
          return;
        }
        if (result.kind === 'error') {
          this.passwordError = 'Сървърът не отговаря — опитай пак';
          return;
        }
        this._adminToken = result.token;
        localStorage.setItem('tennis-admin-token', result.token);
        // Trigger the browser save prompt BEFORE we clear the input or hide
        // the form (Alpine's x-if removes the DOM and would defeat the API).
        await this._offerSaveCredential(formEl);
        this.isAdmin = true;
        this.passwordInput = '';
        return;
      }

      // Local mode — first-time setup or check
      const hash = await this.hashPassword(this.passwordInput);
      if (!this.passwordHash) {
        this.passwordHash = hash;
        await this._offerSaveCredential(formEl);
        this.isAdmin = true;
      } else if (this.passwordHash === hash) {
        await this._offerSaveCredential(formEl);
        this.isAdmin = true;
      } else {
        this.passwordError = 'Грешна парола';
        return;
      }
      this.passwordInput = '';
    },

    async logout() {
      // Best-effort revoke server-side; we proceed regardless of result.
      const token = this._adminToken;
      this.isAdmin = false;
      this._adminToken = null;
      localStorage.removeItem('tennis-admin-token');
      localStorage.removeItem('tennis-admin-pw');
      if (token && this.backendMode === 'api') {
        try {
          await fetch(this.apiBase + '/auth', {
            method: 'DELETE',
            headers: { 'X-Admin-Token': token }
          });
        } catch (_) { /* ignore */ }
      }
    },

    // Force a clean reload: unregister service workers, drop every Cache
    // Storage entry, then reload. Use when a user is stuck on a stale shell
    // and the SW's normal update cycle hasn't kicked in.
    // Preserves localStorage (admin password, persisted state) — only the
    // HTTP/SW cache layer is wiped.
    async hardRefresh() {
      if (!confirm('Изчисти кеша и презареди приложението?')) return;
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (e) { /* best effort — proceed to reload regardless */ }
      // Bypass HTTP cache too. Adding a cache-buster query forces a fresh
      // fetch of index.html even if browsers ignore reload(true).
      const sep = window.location.search ? '&' : '?';
      window.location.replace(window.location.pathname + window.location.search + sep + '_t=' + Date.now() + window.location.hash);
    },

    // Called when an admin-only request gets a 401 — the password we have is
    // stale (changed on the server, or we restored a junk one). Wipe and
    // prompt re-login. Toast is visible and non-blocking so the user knows.
    _handleAdminUnauthorized() {
      if (!this.isAdmin) return;
      this.isAdmin = false;
      this._adminToken = null;
      localStorage.removeItem('tennis-admin-token');
      localStorage.removeItem('tennis-admin-pw');
      this.showToast('⚠️ Сесията изтече — влез отново');
    },

    // ======= HELPERS =======
    formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('bg-BG', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit'
      });
    },

    formatDateLong(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const datePart = d.toLocaleDateString('bg-BG', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
      const timePart = d.toLocaleTimeString('bg-BG', {
        hour: '2-digit', minute: '2-digit'
      });
      return datePart + ' · ' + timePart;
    },

    dateRelative(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tgt = new Date(d);
      tgt.setHours(0, 0, 0, 0);
      const diff = Math.round((tgt - today) / 86400000);
      if (diff === 0) return 'Днес';
      if (diff === 1) return 'Утре';
      if (diff === -1) return 'Вчера';
      if (diff > 1 && diff <= 7) return 'След ' + diff + ' дни';
      if (diff < -1 && diff >= -7) return 'Преди ' + Math.abs(diff) + ' дни';
      return '';
    },

    initials(name) {
      if (!name) return '';
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    },

    // Deterministic hue per player (0-360)
    playerHue(name) {
      if (!name) return 0;
      let h = 0;
      for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) % 360;
      }
      return h;
    },

    // Click on a player anywhere → jump to matches view filtered by them
    jumpToPlayer(name) {
      // Navigate to the duels view and expand that player's card. This used
      // to switch to the Matches view, but Matches was a redundant
      // "grouped-by-player" listing of the same data the Duels view shows
      // from a single player's perspective. Consolidating: one source of
      // truth, one navigation target.
      this.duelExpanded = name;
      this.view = 'grid';
      // Double-RAF so Alpine has rendered the grid view and applied the `open`
      // class before we measure. Instant scroll (no smooth) — a smooth scroll
      // can keep animating after the user taps a different tab, "leaking" the
      // scroll across views.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector('.duel-card-v2.open');
          if (el) el.scrollIntoView({ block: 'start' });
        });
      });
    },

    // Date sub-line for a duel row. Returns "" when there's nothing
    // meaningful to show (pending, no recordedAt). Different from
    // duelRowText which is the score/status on the right.
    duelRowSubline(p, op) {
      const m = this.matchBetween(p, op);
      if (!m) return '';
      if (m.played) {
        const ts = (this.resultsRecordedAt || {})[m.key];
        if (!ts) return '';
        return this.timeFromNow(ts);
      }
      if (m.scheduledAt) {
        // Inside the row we already render duelRowText with the relative
        // time as headline ("УТРЕ", "след 2ч"). Here in the subline we add
        // the absolute time so the user gets both pieces at a glance.
        const d = new Date(m.scheduledAt);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString('bg-BG', {
          day: 'numeric', month: 'short',
          hour: '2-digit', minute: '2-digit'
        });
      }
      return '';
    },

    // True if the match between p and op is happening today (admin / volunteer
    // can record live or final). Used to surface inline scoring CTAs.
    duelCanWriteToday(p, op) {
      const m = this.matchBetween(p, op);
      if (!m) return false;
      return this.canWriteToday(m);
    },

    // Match object for the bottom-sheet open helpers. Used so the duel-row
    // can dispatch openLive(m) / openScore(m) without the row knowing about
    // the underlying match object shape.
    duelMatchOf(p, op) {
      return this.matchBetween(p, op) || null;
    },

    // ======= LIVE SCORING =======
    todayISO() {
      const d = new Date();
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    },

    isMatchToday(match) {
      if (!match || !match.scheduledAt) return false;
      return match.scheduledAt.slice(0, 10) === this.todayISO();
    },

    // True when ANYONE (admin or not) can write a result/live for this match
    canWriteToday(match) {
      if (!match || match.played) return false;
      if (this.isAdmin) return true;
      return this.isMatchToday(match);
    },

    liveOf(match) {
      return (match && this.live[match.key]) || null;
    },

    isMatchLive(match) {
      return !!this.liveOf(match);
    },

    // Compute "sets so far" for a live match (winner perspective from p1)
    liveSetsWon(match) {
      const l = this.liveOf(match);
      if (!l) return [0, 0];
      let a = 0, b = 0;
      for (const [x, y] of (l.sets || [])) {
        if (x > y) a++;
        else if (y > x) b++;
      }
      return [a, b];
    },

    formatLiveScore(match) {
      const l = this.liveOf(match);
      if (!l) return '';
      const parts = (l.sets || []).map(([a, b]) => `${a}:${b}`);
      const [ca, cb] = l.cur || [0, 0];
      const tb = l.tb;
      let curStr;
      if (tb) curStr = `${ca}:${cb} · TB ${tb[0]}:${tb[1]}`;
      else if (ca || cb) curStr = `${ca}:${cb}`;
      else curStr = '';
      if (curStr) parts.push(curStr);
      return parts.join(', ');
    },

    // Show a chooser when user wants to enter today's match result
    openTodayPicker(match) {
      if (!this.canWriteToday(match)) return;
      this.todayPicker = match;
    },

    closeTodayPicker() { this.todayPicker = null; },

    todayPickFinal() {
      const m = this.todayPicker;
      this.todayPicker = null;
      if (m) this.openScore(m);
    },

    todayPickLive() {
      const m = this.todayPicker;
      this.todayPicker = null;
      if (m) this.openLive(m);
    },

    openLive(match) {
      if (!this.canWriteToday(match)) return;
      const existing = this.liveOf(match);
      if (existing) {
        this.liveDraft = {
          sets: (existing.sets || []).map(s => [s[0], s[1]]),
          cur:  [existing.cur ? existing.cur[0] : 0, existing.cur ? existing.cur[1] : 0],
          tb:   existing.tb ? [existing.tb[0], existing.tb[1]] : null
        };
      } else {
        this.liveDraft = { sets: [], cur: [0, 0], tb: null };
      }
      this.liveError = '';
      this.liveMatch = match;
    },

    closeLive() {
      this.liveMatch = null;
      this.liveError = '';
      this.livePending = false;
    },

    liveCurSetWonByLeader() {
      const [a, b] = this.liveDraft.cur;
      return a !== b;
    },

    liveCanEndSet() {
      // Can end the current set if not in tiebreak and game count is unequal
      return !this.liveDraft.tb && this.liveCurSetWonByLeader();
    },

    // If proposedSets would finalize the match (one player at 2 sets won),
    // shows the styled confirm modal instead of the native confirm() dialog.
    // The actual state mutation is deferred until the user accepts.
    _maybeAskFinalize(proposedSets, onConfirm, onCancel) {
      let a = 0, b = 0;
      for (const [x, y] of proposedSets) {
        if (x > y) a++;
        else if (y > x) b++;
      }
      if (a < 2 && b < 2) {
        onConfirm();
        return;
      }
      this.pendingFinalize = {
        setsA: a, setsB: b,
        winner: a > b ? this.liveMatch.p1 : this.liveMatch.p2,
        onConfirm,
        onCancel: onCancel || null
      };
    },

    confirmFinalize() {
      const cb = this.pendingFinalize && this.pendingFinalize.onConfirm;
      this.pendingFinalize = null;
      if (cb) cb();
    },

    cancelFinalize() {
      const cb = this.pendingFinalize && this.pendingFinalize.onCancel;
      this.pendingFinalize = null;
      if (cb) cb();
    },

    liveAddPoint(playerIdx) {
      // playerIdx: 0 (p1) or 1 (p2)
      if (this.liveDraft.tb) {
        this.liveDraft.tb[playerIdx]++;
        const [t0, t1] = this.liveDraft.tb;
        if ((t0 >= 7 || t1 >= 7) && Math.abs(t0 - t1) >= 2) {
          // tiebreak won → set is recorded as 7:6
          const tbWinner = t0 > t1 ? 0 : 1;
          const newSet = tbWinner === 0 ? [7, 6] : [6, 7];
          const proposedSets = [...this.liveDraft.sets, newSet];
          this._maybeAskFinalize(
            proposedSets,
            () => {
              // Confirmed: commit the set, reset cur/tb, persist
              this.liveDraft.sets.push(newSet);
              this.liveDraft.cur = [0, 0];
              this.liveDraft.tb = null;
              this.liveDraft = { ...this.liveDraft };
              this.persistLive();
            },
            () => {
              // Cancelled: undo the TB increment so we don't re-prompt
              this.liveDraft.tb[playerIdx]--;
              this.liveDraft = { ...this.liveDraft };
              this.persistLive();
            }
          );
          return;
        }
      } else {
        this.liveDraft.cur[playerIdx]++;
        // 6:6 → enter tiebreak
        if (this.liveDraft.cur[0] === 6 && this.liveDraft.cur[1] === 6) {
          this.liveDraft.tb = [0, 0];
        }
      }
      // re-bind so Alpine sees the change
      this.liveDraft = { ...this.liveDraft };
      this.persistLive();
    },

    liveSubPoint(playerIdx) {
      if (this.liveDraft.tb) {
        if (this.liveDraft.tb[playerIdx] > 0) this.liveDraft.tb[playerIdx]--;
        // exit tiebreak if both reset to 0
        if (this.liveDraft.tb[0] === 0 && this.liveDraft.tb[1] === 0) {
          // keep tiebreak active — user may still want to score in it
        }
      } else {
        if (this.liveDraft.cur[playerIdx] > 0) this.liveDraft.cur[playerIdx]--;
      }
      this.liveDraft = { ...this.liveDraft };
      this.persistLive();
    },

    liveExitTiebreak() {
      // Cancel tiebreak (e.g. if entered by mistake)
      this.liveDraft.tb = null;
      this.liveDraft = { ...this.liveDraft };
      this.persistLive();
    },

    // Visible only when current set is fresh (0:0) and there's a previous
    // completed set to bring back. Prevents accidental clicks while in play.
    liveCanUndoSet() {
      return !this.liveDraft.tb &&
             this.liveDraft.sets.length > 0 &&
             this.liveDraft.cur[0] === 0 &&
             this.liveDraft.cur[1] === 0;
    },

    // Pop last completed set and restore it as the current in-progress set.
    // User can then ←/→ correct individual games or end the set with the
    // right score.
    liveUndoLastSet() {
      if (!this.liveCanUndoSet()) return;
      const last = this.liveDraft.sets[this.liveDraft.sets.length - 1];
      this.liveDraft = {
        sets: this.liveDraft.sets.slice(0, -1),
        cur: [last[0], last[1]],
        tb: null
      };
      this.persistLive();
    },

    liveEndCurrentSet() {
      if (!this.liveCanEndSet()) return;
      const [a, b] = this.liveDraft.cur;
      const proposedSets = [...this.liveDraft.sets, [a, b]];
      this._maybeAskFinalize(proposedSets, () => {
        this.liveDraft.sets.push([a, b]);
        this.liveDraft.cur = [0, 0];
        this.liveDraft.tb = null;
        this.liveDraft = { ...this.liveDraft };
        this.persistLive();
      });
      // No onCancel: cancel just leaves cur unchanged; user can ←/→ to fix.
    },

    // Local-mode counterpart of the server's auto-finalize (server.js POST
    // /api/match/<key>/live). Promotes a 2-set winner from live → results,
    // stamps recordedAt, clears schedule/live, closes the modal.
    _finalizeLiveLocally(key, setsA, setsB) {
      const m = this.matchByPair && this.matchByPair[key];
      const newResults = { ...this.results, [key]: [setsA, setsB] };
      this.results = newResults;
      const newRecorded = { ...this.resultsRecordedAt, [key]: new Date().toISOString() };
      this.resultsRecordedAt = newRecorded;
      const newLive = { ...this.live };
      delete newLive[key];
      this.live = newLive;
      if (this.schedule[key]) {
        const newSchedule = { ...this.schedule };
        delete newSchedule[key];
        this.schedule = newSchedule;
      }
      this.persistLocal();
      this.closeLive();
      this.showToast('🏆 Финализирано: ' + setsA + ':' + setsB);
    },

    async persistLive() {
      if (!this.liveMatch) return;
      const key = this.liveMatch.key;
      // Mark this key as recently locally-written so a racing poll's pre-POST
      // server snapshot can't overwrite our optimistic update.
      this._recentLocalLive = this._recentLocalLive || {};
      this._recentLocalLive[key] = Date.now();

      // If everything has been undone back to zero, drop the live entry —
      // the match returns to "scheduled" until a real point is recorded again.
      const draftEmpty = this.liveDraft.sets.length === 0 &&
                        this.liveDraft.cur[0] === 0 &&
                        this.liveDraft.cur[1] === 0 &&
                        !this.liveDraft.tb;

      const newLive = { ...this.live };
      if (draftEmpty) {
        delete newLive[key];
      } else {
        newLive[key] = {
          sets: this.liveDraft.sets.map(s => [s[0], s[1]]),
          cur:  [this.liveDraft.cur[0], this.liveDraft.cur[1]],
          tb:   this.liveDraft.tb ? [this.liveDraft.tb[0], this.liveDraft.tb[1]] : null,
          updatedAt: new Date().toISOString()
        };
      }
      this.live = newLive;
      this.persistLocal();

      if (this.backendMode !== 'api') {
        // Local mode has no server to auto-finalize. If 2 sets are won we
        // must promote live → results client-side, mirroring server.js.
        if (!draftEmpty) {
          let a = 0, b = 0;
          for (const [x, y] of this.liveDraft.sets) {
            if (x > y) a++;
            else if (y > x) b++;
          }
          if (a >= 2 || b >= 2) this._finalizeLiveLocally(key, a, b);
        }
        return;
      }
      this.livePending = true;
      this.liveError = '';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (this._adminToken) headers['X-Admin-Token'] = this._adminToken;
        const r = await fetch(this.apiBase + '/match/' + encodeURIComponent(key) + '/live', {
          method: 'POST',
          headers,
          body: JSON.stringify(this.liveDraft)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          this.liveError = data.error || 'Грешка при запис';
          this.showToast('⚠️ ' + this.liveError);
          this.livePending = false;
          // Match was finalized elsewhere (409 conflict) — close the modal
          // so the user stops trying to score a finished match.
          if (r.status === 409) this.closeLive();
          return;
        }
        this.livePending = false;
        if (data.cleared) {
          // Server confirmed the live entry was removed (state went back to
          // 0:0). Local state is already cleared via optimistic update.
          this.showToast('↩ Live изчистен — мачът пак е предстоящ');
        }
        if (data.finalized) {
          // Server promoted live → results
          this._fromServer = true;
          const newResults = { ...this.results };
          newResults[key] = data.result;
          this.results = newResults;
          const newRecorded = { ...this.resultsRecordedAt };
          newRecorded[key] = new Date().toISOString();
          this.resultsRecordedAt = newRecorded;
          const ll = { ...this.live };
          delete ll[key];
          this.live = ll;
          if (this.schedule[key]) {
            const ns = { ...this.schedule };
            delete ns[key];
            this.schedule = ns;
          }
          Promise.resolve().then(() => { this._fromServer = false; });
          this.closeLive();
          this.showToast('🏆 Финализирано: ' + data.result.join(':'));
        }
      } catch (e) {
        this.liveError = 'Мрежова грешка';
        this.showToast('⚠️ ' + this.liveError);
        this.livePending = false;
      }
    },

    async clearLive(match) {
      if (!this.isAdmin || !match) return;
      if (!confirm('⚠️ Това ще ИЗТРИЕ текущия live резултат — всички въведени геймове и сетове.\n\nНе може да се възстанови. Сигурен ли си?')) return;
      const key = match.key;
      // Optimistic local removal
      const ll = { ...this.live };
      delete ll[key];
      this.live = ll;
      // Belt-and-suspenders: explicit localStorage write so a refresh
      // before $watch fires doesn't resurrect the entry from local cache
      this.persistLocal();
      if (this.backendMode !== 'api') return;
      try {
        const r = await fetch(this.apiBase + '/match/' + encodeURIComponent(key) + '/live', {
          method: 'DELETE',
          headers: { 'X-Admin-Token': this._adminToken || '' }
        });
        if (!r.ok) {
          this.showToast('⚠️ Грешка при изтриване на live');
          return;
        }
        this.showToast('🗑 Live изтрит. За нов — натисни "🔴 На живо" на мача.');
      } catch (e) {
        this.showToast('⚠️ Мрежова грешка при изтриване на live');
      }
    },

    _recoverLocalLive() {
      let local;
      try {
        const raw = localStorage.getItem('tennis-v1');
        if (!raw) return;
        local = JSON.parse(raw);
      } catch (e) { return; }
      const localLive = local && local.live;
      if (!localLive) return;
      // Recover entries written in the last 10 minutes. A real match between
      // games can have multi-minute pauses; a 30s window was losing legit
      // unsent updates on flaky 4G. Server-side dedupe protects against stale
      // resends — if server already has fresher state (or deleted it), the
      // POST is a no-op or 409.
      const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
      const now = Date.now();
      const merged = { ...this.live };
      const toResend = [];
      for (const k in localLive) {
        if (this.results[k]) continue;  // server has it as finalized
        const srv = merged[k];
        const loc = localLive[k];
        if (!loc) continue;
        const sT = srv && srv.updatedAt ? Date.parse(srv.updatedAt) : 0;
        const lT = loc.updatedAt ? Date.parse(loc.updatedAt) : 0;
        if (lT > sT && (now - lT) < RECOVERY_WINDOW_MS) {
          merged[k] = loc;
          toResend.push([k, loc]);
        }
      }
      if (toResend.length) {
        this.live = merged;
        toResend.forEach(([k, ent]) => this._resendLive(k, ent));
      }
    },

    async _resendLive(key, ent) {
      if (this.backendMode !== 'api') return;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (this._adminToken) headers['X-Admin-Token'] = this._adminToken;
        await fetch(this.apiBase + '/match/' + encodeURIComponent(key) + '/live', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sets: ent.sets, cur: ent.cur, tb: ent.tb })
        });
      } catch (e) {}
    },

    // Today's UPCOMING matches: scheduled time still in the future. Past-time
    // matches go into matchesShouldBeLive (own banner with prominent CTA).
    get todaysMatches() {
      const t = this.todayISO();
      const now = this._now;
      return this.matches.filter(m => {
        if (m.played || this.live[m.key]) return false;
        if (!m.scheduledAt || m.scheduledAt.slice(0, 10) !== t) return false;
        return new Date(m.scheduledAt).getTime() > now;
      });
    },

    // Matches whose scheduled time is past but no live data was entered yet.
    // Promoted to a big "time to start" banner so it's visually obvious that
    // the match should be happening right now.
    get matchesShouldBeLive() {
      const t = this.todayISO();
      const now = this._now;
      return this.matches.filter(m => {
        if (m.played || this.live[m.key]) return false;
        if (!m.scheduledAt || m.scheduledAt.slice(0, 10) !== t) return false;
        return new Date(m.scheduledAt).getTime() <= now;
      });
    },

    // Human-readable relative time. Used for both "scheduled at" countdown
    // and "result recorded at" history.
    timeFromNow(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const diffMin = Math.round((this._now - d.getTime()) / 60000);
      if (diffMin <= -60) return 'след ' + Math.round(-diffMin / 60) + 'ч';
      if (diffMin < 0) return 'след ' + (-diffMin) + 'мин';
      if (diffMin < 1) return 'сега';
      if (diffMin < 60) return 'преди ' + diffMin + 'мин';
      if (diffMin < 60 * 24) return 'преди ' + Math.round(diffMin / 60) + 'ч';
      if (diffMin < 60 * 24 * 7) return 'преди ' + Math.round(diffMin / (60 * 24)) + 'д';
      return d.toLocaleDateString('bg-BG', { day: 'numeric', month: 'short' });
    },

    // scheduledMatches captured at recomputeDerived time may include
    // entries that were "today/future" then but are "yesterday" now if the
    // page survived past midnight without any data change. This getter
    // re-filters using the live current date.
    get activeScheduledMatches() {
      const todayStr = this.todayISO();
      return this.scheduledMatches.filter(m => m.scheduledAt && m.scheduledAt.slice(0, 10) >= todayStr);
    },

    // Ordered list of non-empty groups for the Upcoming view. Each group
    // describes how to render: title, icon, hero flag (visual emphasis), and
    // its matches sorted by scheduled time. Empty groups are filtered out so
    // the page doesn't show "Тази седмица: (nothing)" gaps.
    get upcomingGroups() {
      const g = this.groupedScheduledMatches;
      const sortByTime = (a, b) => a.scheduledAt.localeCompare(b.scheduledAt);
      g.today.sort(sortByTime);
      g.thisWeek.sort(sortByTime);
      g.later.sort(sortByTime);
      const out = [];
      if (g.today.length > 0)    out.push({ key: 'today',     title: 'Днес',                icon: '📅', hero: true,  items: g.today });
      if (g.thisWeek.length > 0) out.push({ key: 'this-week', title: 'Тази седмица',         icon: '🗓',  hero: false, items: g.thisWeek });
      if (g.later.length > 0)    out.push({ key: 'later',     title: 'Следващи седмици',     icon: '⏭',  hero: false, items: g.later });
      return out;
    },

    // Countdown to a scheduled match — "след 2ч 15мин" / "след 3д 5ч". Returns
    // empty string if the match is in the past or the input is invalid.
    countdownTo(iso) {
      if (!iso) return '';
      const target = new Date(iso).getTime();
      if (isNaN(target)) return '';
      const diffMs = target - this._now;
      if (diffMs <= 0) return '';
      const totalMin = Math.floor(diffMs / 60000);
      if (totalMin < 60) return 'след ' + totalMin + ' мин';
      const totalHrs = Math.floor(totalMin / 60);
      const remMin = totalMin % 60;
      if (totalHrs < 24) {
        return remMin > 0 ? `след ${totalHrs}ч ${remMin}мин` : `след ${totalHrs}ч`;
      }
      const days = Math.floor(totalHrs / 24);
      const remHrs = totalHrs % 24;
      if (days < 7) {
        return remHrs > 0 ? `след ${days}д ${remHrs}ч` : `след ${days}д`;
      }
      return '';  // > 1 week — drop the countdown, the date itself is enough
    },

    // Group scheduledMatches into 3 buckets for the Upcoming view.
    // Boundaries: today / rest of this calendar week (through Sunday) / later.
    get groupedScheduledMatches() {
      const todayStr = this.todayISO();
      const today = new Date(todayStr + 'T00:00:00');
      const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
      // Days until next Monday: Sun→1, Mon→7, Tue→6, Wed→5, ..., Sat→2.
      const daysUntilNextMonday = ((8 - dayOfWeek) % 7) || 7;
      const startOfNextWeek = new Date(today);
      startOfNextWeek.setDate(startOfNextWeek.getDate() + daysUntilNextMonday);
      const nextWeekStr = this.toISODate(startOfNextWeek);

      const groups = { today: [], thisWeek: [], later: [] };
      for (const m of this.activeScheduledMatches) {
        const d = m.scheduledAt.slice(0, 10);
        if (d === todayStr) groups.today.push(m);
        else if (d < nextWeekStr) groups.thisWeek.push(m);
        else groups.later.push(m);
      }
      return groups;
    },

    // Last 5 timestamped results. Undated entries (legacy seed-imports or
    // pre-timestamping app entries) are excluded — without a real recordedAt
    // we can't honestly date them, and the home panel is meant to show
    // genuinely recent activity.
    get recentResults() {
      const recAt = this.resultsRecordedAt || {};
      const out = [];
      for (const m of this.matches) {
        if (!m.played) continue;
        const ts = recAt[m.key];
        if (!ts) continue;
        out.push({ key: m.key, match: m, recordedAt: ts });
      }
      out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      return out.slice(0, 5);
    },

    // Group recentResults by recorded-day. Labels: Днес / Вчера / "5 май".
    get recentResultsByDate() {
      const recent = this.recentResults;
      if (recent.length === 0) return [];

      const todayStr = this.todayISO();
      const y = new Date(todayStr + 'T00:00:00');
      y.setDate(y.getDate() - 1);
      const yesterdayStr = this.toISODate(y);

      const groups = [];
      let cur = null;
      for (const r of recent) {
        const d = r.recordedAt.slice(0, 10);
        let label;
        if (d === todayStr) label = 'Днес';
        else if (d === yesterdayStr) label = 'Вчера';
        else label = new Date(r.recordedAt).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
        if (!cur || cur.label !== label) {
          cur = { label, items: [] };
          groups.push(cur);
        }
        cur.items.push(r);
      }
      return groups;
    },

    get liveMatchesList() {
      const list = [];
      for (const key in this.live) {
        const m = this.matchByPair[key];
        if (m && !m.played) list.push(m);
      }
      return list;
    },

    // ===== Admin v2 derived state =====

    // "Днес · 11 май, понеделник" — header for the today hero.
    get adminTodayLabel() {
      const d = new Date();
      // toLocaleDateString in bg-BG: "понеделник, 11 май"
      const human = d.toLocaleDateString('bg-BG', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
      return 'Днес · ' + human;
    },

    // Are there ANY matches that warrant the today hero?
    get adminHasTodayContent() {
      return this.liveMatchesList.length > 0
        || this.matchesShouldBeLive.length > 0
        || this.todaysMatches.length > 0;
    },

    // Scheduled matches NOT today, not played, sorted by scheduled time asc.
    // (todaysMatches handles "today scheduled future"; this is everything later.)
    get adminFutureMatches() {
      const todayStr = this.todayISO();
      return this.activeScheduledMatches
        .filter(m => m.scheduledAt && m.scheduledAt.slice(0, 10) > todayStr)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    },

    // Played matches grouped by recordedAt date (descending).
    // Undated entries (legacy) collected into a single "По-стари" bucket.
    get adminPlayedByDate() {
      const recAt = this.resultsRecordedAt || {};
      const todayStr = this.todayISO();
      const y = new Date(todayStr + 'T00:00:00');
      y.setDate(y.getDate() - 1);
      const yesterdayStr = this.toISODate(y);

      const dated = [];
      const undated = [];
      for (const m of this.playedMatches) {
        const ts = recAt[m.key];
        if (ts) dated.push({ m, ts });
        else undated.push(m);
      }
      dated.sort((a, b) => b.ts.localeCompare(a.ts));

      const groups = [];
      let cur = null;
      for (const { m, ts } of dated) {
        const d = ts.slice(0, 10);
        let label;
        if (d === todayStr) label = 'Днес';
        else if (d === yesterdayStr) label = 'Вчера';
        else label = new Date(ts).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
        if (!cur || cur.label !== label) {
          cur = { label, items: [] };
          groups.push(cur);
        }
        cur.items.push(m);
      }
      if (undated.length > 0) groups.push({ label: 'По-стари', items: undated });
      return groups;
    },

    // Decide the ONE primary action button for a match given its state.
    // Returns { label, icon, kind, handler }. Safe to call with null/undefined
    // (Alpine evaluates bindings inside x-if before rendering the gate).
    primaryActionFor(m) {
      if (!m) return { label: '', icon: '', kind: 'primary', handler: () => {} };
      if (m.played) {
        return { label: 'Редактирай', icon: '✎', kind: 'ghost', handler: () => this.openScore(m) };
      }
      if (this.isMatchLive(m)) {
        return { label: 'Продължи на живо', icon: '▶', kind: 'live', handler: () => this.openLive(m) };
      }
      // Scheduled today (any time) → primary is "live". For future-day matches
      // primary is "result" since admin most often pre-records, not live-scores.
      const todayStr = this.todayISO();
      const isToday = m.scheduledAt && m.scheduledAt.slice(0, 10) === todayStr;
      if (isToday) {
        return { label: 'На живо', icon: '▶', kind: 'live', handler: () => this.openLive(m) };
      }
      return { label: 'Резултат', icon: '🎾', kind: 'primary', handler: () => this.openScore(m) };
    },

    // Secondary actions for a match's bottom-sheet menu. Filtered by state.
    secondaryActionsFor(m) {
      if (!m) return [];
      const acts = [];
      if (m.played) {
        acts.push({ label: 'Изтрий резултата', icon: '✕', danger: true,
          handler: () => { if (confirm('Изтрий резултата?')) this.clearResult(m); } });
        return acts;
      }
      // Not played:
      const primary = this.primaryActionFor(m);
      if (primary.kind !== 'live') {
        acts.push({ label: this.isMatchLive(m) ? 'Продължи на живо' : 'На живо',
          icon: '▶', handler: () => this.openLive(m) });
      }
      if (primary.kind !== 'primary') {
        acts.push({ label: 'Запиши резултат', icon: '🎾',
          handler: () => this.openScore(m) });
      }
      acts.push({
        label: m.scheduledAt ? 'Премести' : 'Планирай',
        icon: '📅',
        handler: () => this.openSchedule(m)
      });
      if (m.scheduledAt) {
        acts.push({ label: 'Откажи план', icon: '✕', danger: true,
          handler: () => { if (confirm('Откажи планираната дата?')) this.clearSchedule(m); } });
      }
      if (this.isMatchLive(m)) {
        acts.push({ label: 'Изтрий live', icon: '🗑', danger: true,
          handler: () => this.clearLive(m) });
      }
      return acts;
    },

    openMatchActions(m) {
      this.adminMatchActions = m;
    },

    closeMatchActions() {
      this.adminMatchActions = null;
    },

    // ===== Players drawer helpers =====

    // Return the standings entry for a player (or a zero-stats stub).
    playerStanding(name) {
      return this.standings.find(s => s.name === name)
        || { name, played: 0, wins: 0, losses: 0 };
    },

    // Filtered + grouped player list for the drawer. Matches the standings
    // pattern: active first (≥1 played), then inactive, with search applied
    // to both.
    get adminPlayersGrouped() {
      const q = (this.playerSearch || '').trim().toLowerCase();
      const active = [], inactive = [];
      for (const p of this.players) {
        if (q && !p.toLowerCase().includes(q)) continue;
        const s = this.playerStanding(p);
        if (s.played > 0) active.push(s);
        else inactive.push(s);
      }
      // Active sorted by standings (best first); inactive alphabetical.
      active.sort((x, y) => (this.standings.indexOf(x) - this.standings.indexOf(y)));
      inactive.sort((x, y) => x.name.localeCompare(y.name, 'bg'));
      return { active, inactive };
    },

    startEditPlayer(name) {
      this.playerEditing = name;
      this.playerEditValue = name;
      this.playerEditError = '';
      // Focus the input on the next paint — Alpine swaps the row template
      // first; querying immediately returns the old DOM.
      requestAnimationFrame(() => {
        const el = document.querySelector('.player-row.editing input');
        if (el) { el.focus(); el.select(); }
      });
    },

    cancelEditPlayer() {
      this.playerEditing = null;
      this.playerEditValue = '';
      this.playerEditError = '';
    },

    async saveEditPlayer() {
      const oldName = this.playerEditing;
      const newName = (this.playerEditValue || '').trim();
      if (!oldName) return;
      if (!newName) { this.playerEditError = 'Името не може да е празно'; return; }
      if (newName === oldName) { this.cancelEditPlayer(); return; }
      const res = await this.renamePlayer(oldName, newName);
      if (res.ok) {
        this.cancelEditPlayer();
      } else {
        this.playerEditError = res.error || 'Грешка';
      }
    },

    confirmDeletePlayer(name) {
      this.playerDeleting = this.playerStanding(name);
    },

    cancelDeletePlayer() {
      this.playerDeleting = null;
    },

    async executeDeletePlayer() {
      const p = this.playerDeleting;
      if (!p) return;
      const res = await this.deletePlayer(p.name);
      this.playerDeleting = null;
      if (!res.ok) {
        // Reuse the toast — small, non-blocking, fits the rest of the UI.
        this.showToast('✕ ' + (res.error || 'Грешка'));
      }
    },

    // ======= EXPORT / IMPORT =======
    exportData() {
      const data = JSON.stringify({
        players: this.players,
        results: this.results,
        schedule: this.schedule,
        live: this.live,
        resultsRecordedAt: this.resultsRecordedAt,
        exportedAt: new Date().toISOString()
      }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tennis-velingrad-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    importData(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = JSON.parse(e.target.result);
          if (!data.results) throw new Error('Невалиден файл');
          if (!confirm('Това ще замени текущите данни. Продължи?')) return;
          if (Array.isArray(data.players) && data.players.length) this.players = data.players;
          this.results = data.results;
          this.schedule = data.schedule || {};
          this.live = data.live || {};
          this.resultsRecordedAt = data.resultsRecordedAt || {};
        } catch (err) {
          alert('Грешка при четене: ' + err.message);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    },

    // ======= WEB PUSH =======
    //
    // Browser-side glue for OS-level push notifications. Detects support, asks
    // the server for the VAPID public key, and reflects current subscription
    // state in the `push` reactive object so the UI can render a single
    // bell-toggle button. Hidden entirely on unsupported browsers (e.g. iOS
    // Safari without "Add to Home Screen").
    async initPush() {
      // Feature detect: needs SW + PushManager + Notification API. Push only
      // makes sense in api mode (server is the sender).
      const supported =
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window &&
        this.backendMode === 'api';
      this.push.supported = supported;
      if (!supported) return;
      this.push.permission = Notification.permission;
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          this.push.subscribed = true;
          this.push.endpoint = existing.endpoint;
        }
        // Fetch VAPID key lazily (only needed when subscribing).
        const r = await fetch('/api/push/vapid-public-key');
        if (r.ok) {
          const j = await r.json();
          this.push.vapidKey = j.publicKey;
        } else {
          // Server has push disabled (no VAPID env vars). Keep UI hidden.
          this.push.supported = false;
        }
      } catch (e) {
        console.warn('[push] init failed', e);
      }
    },

    async togglePush() {
      if (!this.push.supported || this.push.pending) return;
      this.push.pending = true;
      try {
        if (this.push.subscribed) {
          await this._unsubscribePush();
          this.toast = 'Спряхте известията';
          setTimeout(() => { this.toast = ''; }, 2000);
        } else {
          await this._subscribePush();
          this.toast = '🔔 Абонирани сте за известия';
          setTimeout(() => { this.toast = ''; }, 2500);
        }
      } catch (e) {
        const msg = (e && e.message) || 'Грешка при абониране';
        this.toast = msg;
        setTimeout(() => { this.toast = ''; }, 3000);
      } finally {
        this.push.pending = false;
      }
    },

    async _subscribePush() {
      // Ask permission. requestPermission resolves with current state if it
      // was already decided, so it's safe to call unconditionally.
      const perm = await Notification.requestPermission();
      this.push.permission = perm;
      if (perm !== 'granted') {
        throw new Error(perm === 'denied'
          ? 'Известията са блокирани от браузъра. Разрешете ги от настройките.'
          : 'Не разрешихте известия.');
      }
      if (!this.push.vapidKey) throw new Error('Сървърът не е готов за push.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(this.push.vapidKey)
      });
      const subJson = sub.toJSON();
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subJson)
      });
      if (!r.ok) {
        // Roll back the local subscription so the user can retry cleanly.
        try { await sub.unsubscribe(); } catch (e) {}
        throw new Error('Сървърът отказа абонамента (HTTP ' + r.status + ').');
      }
      this.push.subscribed = true;
      this.push.endpoint = sub.endpoint;
    },

    async _unsubscribePush() {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub ? sub.endpoint : this.push.endpoint;
      if (sub) { try { await sub.unsubscribe(); } catch (e) {} }
      if (endpoint) {
        // Best-effort: server prunes 410s on next send anyway, but explicit
        // is cleaner.
        try {
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint })
          });
        } catch (e) {}
      }
      this.push.subscribed = false;
      this.push.endpoint = null;
    },

    // VAPID public key arrives as URL-safe base64; PushManager wants Uint8Array.
    _urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
      return out;
    }
  }));
});
