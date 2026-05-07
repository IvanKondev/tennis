document.addEventListener('alpine:init', () => {
  Alpine.data('tennisApp', () => ({
    // ======= STATE =======
    view: 'standings',
    results: {},
    schedule: {},
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

    // ======= INIT =======
    async init() {
      await this.detectBackend();
      await this.load();

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

      // Persist on changes
      this.$watch('results', () => this.persist());
      this.$watch('schedule', () => this.persist());
      this.$watch('passwordHash', () => this.persistLocal());

      // Reset scroll on tab change
      this.$watch('view', () => window.scrollTo(0, 0));
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
            const data = await r.json();
            this.results = data.results || {};
            this.schedule = data.schedule || {};
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
      this.passwordHash = null;
      this.persistLocal();
    },

    persistLocal() {
      localStorage.setItem('tennis-v1', JSON.stringify({
        results: this.results,
        schedule: this.schedule,
        passwordHash: this.passwordHash
      }));
    },

    async persist() {
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
            schedule: this.schedule
          })
        });
        if (!r.ok) throw new Error('save failed: ' + r.status);
        this.saveStatus = 'saved';
        setTimeout(() => { if (this.saveStatus === 'saved') this.saveStatus = ''; }, 2000);
      } catch (e) {
        this.saveStatus = 'error';
        console.error('[persist]', e);
      }
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

    get matches() {
      return MATCHES_SEED.map((m, i) => {
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
    },

    get playedMatches() { return this.matches.filter(m => m.played); },

    get scheduledMatches() {
      return this.matches
        .filter(m => !m.played && m.scheduledAt)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    },

    get standings() {
      const stats = {};
      PLAYERS.forEach(p => stats[p] = {
        name: p, played: 0, wins: 0, losses: 0,
        setsWon: 0, setsLost: 0, points: 0
      });
      this.matches.forEach(m => {
        if (!m.played) return;
        const a = stats[m.p1], b = stats[m.p2];
        a.played++; b.played++;
        a.setsWon += m.s1; a.setsLost += m.s2;
        b.setsWon += m.s2; b.setsLost += m.s1;
        if (m.winner === m.p1) { a.wins++; a.points++; b.losses++; }
        else { b.wins++; b.points++; a.losses++; }
      });
      const arr = Object.values(stats);
      arr.sort((x, y) => {
        if (y.points !== x.points) return y.points - x.points;
        if (y.wins !== x.wins) return y.wins - x.wins;
        const dx = x.setsWon - x.setsLost;
        const dy = y.setsWon - y.setsLost;
        if (dy !== dx) return dy - dx;
        if (y.setsWon !== x.setsWon) return y.setsWon - x.setsWon;
        return x.name.localeCompare(y.name, 'bg');
      });
      return arr;
    },

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

      const groups = {};
      PLAYERS.forEach(p => groups[p] = []);
      this.matches.forEach(m => {
        if (!matchPasses(m)) return;
        groups[m.p1].push(m);
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
      return this.matches.find(m =>
        (m.p1 === a && m.p2 === b) || (m.p1 === b && m.p2 === a)
      );
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
      if (this.schedule[match.key]) {
        const newSchedule = { ...this.schedule };
        delete newSchedule[match.key];
        this.schedule = newSchedule;
      }
      this.scoreMatch = null;
    },

    clearResult(match) {
      const newResults = { ...this.results };
      delete newResults[match.key];
      this.results = newResults;
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

    // ======= EXPORT / IMPORT =======
    exportData() {
      const data = JSON.stringify({
        results: this.results,
        schedule: this.schedule,
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
        } catch (err) {
          alert('Грешка при четене: ' + err.message);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }
  }));
});
