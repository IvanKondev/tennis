document.addEventListener('alpine:init', () => {
  Alpine.data('tennisApp', () => ({
    // ======= STATE =======
    view: 'standings',
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
      '17:00','17:30','18:00'
    ],

    playerPicker: {
      open: false,
      title: 'Избери играч',
      showAll: true,
      callback: null
    },

    duelExpanded: null,

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

    // ===== Derived state (recomputed only when results/schedule change) =====
    matches: [],
    matchByPair: {},
    playedMatches: [],
    scheduledMatches: [],
    standings: [],

    // ======= INIT =======
    async init() {
      await this.detectBackend();
      await this.load();
      this.recomputeDerived();

      // Auto-restore admin auth from localStorage (admin device only)
      const savedPass = localStorage.getItem('tennis-admin-pw');
      if (savedPass && this.backendMode === 'api') {
        const ok = await this.verifyApiPassword(savedPass);
        if (ok) {
          this._adminPassword = savedPass;
          this.isAdmin = true;
        } else {
          localStorage.removeItem('tennis-admin-pw');
        }
      }

      // Persist + recompute on changes
      this.$watch('results', () => { this.recomputeDerived(); this.persist(); });
      this.$watch('schedule', () => { this.recomputeDerived(); this.persist(); });
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

    recomputeDerived() {
      // Build matches array
      const matches = MATCHES_SEED.map((m, i) => {
        const key = m[0] + '|' + m[1];
        const r = this.results[key];
        const sched = this.schedule[key];
        let s1 = null, s2 = null, played = false, winner = null, loser = null;
        if (r) {
          s1 = r[0]; s2 = r[1];
          played = true;
          if (s1 > s2) { winner = m[0]; loser = m[1]; }
          else { winner = m[1]; loser = m[0]; }
        }
        return {
          num: i + 1, key,
          p1: m[0], p2: m[1],
          s1, s2, played, winner, loser,
          scheduledAt: sched || null
        };
      });

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
      PLAYERS.forEach(p => stats[p] = {
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
      if (!this._adminPassword) return;
      this.saveStatus = 'saving';
      try {
        const r = await fetch(this.apiBase + '/data', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Password': this._adminPassword
          },
          body: JSON.stringify({
            results: this.results,
            schedule: this.schedule,
            live: this.live,
            resultsRecordedAt: this.resultsRecordedAt
          })
        });
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

    async verifyApiPassword(password) {
      try {
        const r = await fetch(this.apiBase + '/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        return r.ok;
      } catch (e) {
        return false;
      }
    },

    // ======= COMPUTED =======
    get players() { return PLAYERS; },

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
      PLAYERS.forEach(p => groups[p] = []);
      this.matches.forEach(m => {
        if (!matchPasses(m)) return;
        groups[m.p1].push(m);
        groups[m.p2].push(m);
      });
      return PLAYERS
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

    duelOpponents(p) {
      // Sort: played wins first, then losses, then scheduled, then pending
      return PLAYERS
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
      if (this.backendMode === 'api' && !this._adminPassword) {
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
      return PLAYERS
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

    async submitPassword() {
      this.passwordError = '';
      if (!this.passwordInput || this.passwordInput.length < 4) {
        this.passwordError = 'Минимум 4 символа';
        return;
      }

      // API mode — verify against server
      if (this.backendMode === 'api') {
        const ok = await this.verifyApiPassword(this.passwordInput);
        if (!ok) {
          this.passwordError = 'Грешна парола';
          return;
        }
        this._adminPassword = this.passwordInput;
        localStorage.setItem('tennis-admin-pw', this.passwordInput);
        this.isAdmin = true;
        this.passwordInput = '';
        return;
      }

      // Local mode — first-time setup or check
      const hash = await this.hashPassword(this.passwordInput);
      if (!this.passwordHash) {
        this.passwordHash = hash;
        this.isAdmin = true;
      } else if (this.passwordHash === hash) {
        this.isAdmin = true;
      } else {
        this.passwordError = 'Грешна парола';
        return;
      }
      this.passwordInput = '';
    },

    logout() {
      this.isAdmin = false;
      this._adminPassword = null;
      localStorage.removeItem('tennis-admin-pw');
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
      this.matchPlayerFilter = name;
      this.matchSearch = '';
      this.matchFilter = 'all';
      this.view = 'matches';
      // scroll handled by view watcher
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
        if (this._adminPassword) headers['X-Admin-Password'] = this._adminPassword;
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
          headers: { 'X-Admin-Password': this._adminPassword || '' }
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
        if (this._adminPassword) headers['X-Admin-Password'] = this._adminPassword;
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

    // ======= EXPORT / IMPORT =======
    exportData() {
      const data = JSON.stringify({
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
    }
  }));
});
