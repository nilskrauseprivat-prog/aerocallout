/*
 * AeroCallout - readable names for aircraft and airlines, and flight routes (origin / destination).
 *  - airline: from the ICAO prefix of the callsign (built-in table of common operators)
 *  - type: from the ICAO type designator (built-in table of common types, otherwise the code itself)
 *  - route: adsb.im route database (POST /api/0/routeset), cached per callsign
 */
(function (AC) {
  'use strict';

  const AIRLINES = {
    DLH: 'Lufthansa', EWG: 'Eurowings', CFG: 'Condor', TUI: 'TUIfly', TFL: 'TUI', SWR: 'Swiss', AUA: 'Austrian',
    BEL: 'Brussels Airlines', DLA: 'Air Dolomiti', CLH: 'Lufthansa CityLine', LHX: 'Lufthansa City', GEC: 'Lufthansa Cargo',
    RYR: 'Ryanair', RUK: 'Ryanair UK', EZY: 'easyJet', EZS: 'easyJet Switzerland', EJU: 'easyJet Europe', WZZ: 'Wizz Air',
    WMT: 'Wizz Air Malta', VLG: 'Vueling', IBE: 'Iberia', AEA: 'Air Europa', BAW: 'British Airways', VIR: 'Virgin Atlantic',
    AFR: 'Air France', KLM: 'KLM', TRA: 'Transavia', TVF: 'Transavia France', SAS: 'SAS', NAX: 'Norwegian', NSZ: 'Norwegian',
    FIN: 'Finnair', ICE: 'Icelandair', LOT: 'LOT', CSA: 'Czech Airlines', TAP: 'TAP Air Portugal', AZA: 'ITA Airways',
    ITY: 'ITA Airways', AEE: 'Aegean', THY: 'Turkish Airlines', PGT: 'Pegasus', SXS: 'SunExpress', UAE: 'Emirates',
    QTR: 'Qatar Airways', ETD: 'Etihad', SVA: 'Saudia', ELY: 'El Al', MSR: 'EgyptAir', RAM: 'Royal Air Maroc',
    DAL: 'Delta', UAL: 'United', AAL: 'American', ACA: 'Air Canada', JBU: 'JetBlue', SIA: 'Singapore Airlines',
    CPA: 'Cathay Pacific', CCA: 'Air China', CES: 'China Eastern', CSN: 'China Southern', ANA: 'ANA', JAL: 'Japan Airlines',
    KAL: 'Korean Air', AIC: 'Air India', THA: 'Thai Airways', QFA: 'Qantas', ETH: 'Ethiopian', KQA: 'Kenya Airways',
    UPS: 'UPS', FDX: 'FedEx', DHK: 'DHL', BCS: 'DHL (EAT Leipzig)', DHX: 'DHL', CLX: 'Cargolux', ABW: 'AirBridgeCargo',
    SRR: 'Star Air (UPS)', BOX: 'AeroLogic', MPH: 'Martinair', GTI: 'Atlas Air', CKS: 'Kalitta', QTR_C: 'Qatar Cargo',
    LGL: 'Luxair', BTI: 'airBaltic', ROT: 'TAROM', BUC: 'Bulgarian Air', MLD: 'Air Moldova', OAW: 'Helvetic',
    EDW: 'Edelweiss', SCX: 'Sun Country', MAY: 'Marabu', DCS: 'DC Aviation', NJE: 'NetJets Europe', VJT: 'VistaJet',
    GAF: 'Luftwaffe', GAM: 'German Army', GNY: 'German Navy', RCH: 'US Air Force (AMC)', RRR: 'Royal Air Force',
    CHX: 'ADAC Luftrettung (Christoph)', DRF: 'DRF Luftrettung', BPO: 'Bundespolizei', PLF: 'Polish Air Force',
  };

  const TYPES = {
    A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo', A318: 'Airbus A318', A319: 'Airbus A319',
    A320: 'Airbus A320', A321: 'Airbus A321', A332: 'Airbus A330-200', A333: 'Airbus A330-300', A339: 'Airbus A330-900',
    A343: 'Airbus A340-300', A346: 'Airbus A340-600', A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380',
    BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300', A400: 'Airbus A400M', A306: 'Airbus A300', A310: 'Airbus A310',
    B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900', B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8',
    B39M: 'Boeing 737 MAX 9', B3XM: 'Boeing 737 MAX 10', B744: 'Boeing 747-400', B748: 'Boeing 747-8', B752: 'Boeing 757-200',
    B763: 'Boeing 767-300', B764: 'Boeing 767-400', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B77W: 'Boeing 777-300ER',
    B778: 'Boeing 777-8', B779: 'Boeing 777-9', B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
    B762: 'Boeing 767-200', B753: 'Boeing 757-300', B733: 'Boeing 737-300', B734: 'Boeing 737-400', B735: 'Boeing 737-500',
    B736: 'Boeing 737-600', B77F: 'Boeing 777F', B74F: 'Boeing 747F', B74S: 'Boeing 747SP', A30B: 'Airbus A300', A3ST: 'Airbus Beluga',
    A337: 'Airbus BelugaXL', A342: 'Airbus A340-200', A345: 'Airbus A340-500', A338: 'Airbus A330-800', A332F: 'Airbus A330F',
    MD11: 'McDonnell Douglas MD-11', MD82: 'McDonnell Douglas MD-82', B712: 'Boeing 717', AN12: 'Antonov An-12', A124: 'Antonov An-124',
    IL76: 'Iljuschin Il-76', E135: 'Embraer Legacy', E145: 'Embraer 145', E55P: 'Phenom 300', E50P: 'Phenom 100',
    C510: 'Citation Mustang', C525: 'Citation CJ', C550: 'Citation II', C560: 'Citation V', C680: 'Citation Sovereign',
    BE20: 'King Air 200', BE9L: 'King Air 90', BE35: 'Bonanza', BE58: 'Baron', P180: 'Piaggio Avanti', TBM9: 'TBM 900',
    TBM7: 'TBM 700', M20P: 'Mooney', PA34: 'Piper Seneca', PA46: 'Piper Malibu', D228: 'Dornier 228', D328: 'Dornier 328',
    J328: 'Fairchild Dornier 328JET', DHC6: 'Twin Otter', AT43: 'ATR 42', F100: 'Fokker 100', F70: 'Fokker 70', E170: 'Embraer 170', E175: 'Embraer 175', E190: 'Embraer 190', E195: 'Embraer 195',
    E290: 'Embraer E190-E2', E295: 'Embraer E195-E2', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900',
    CRJX: 'Bombardier CRJ1000', DH8D: 'Dash 8-400', AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600', AT45: 'ATR 42-500',
    SF34: 'Saab 340', C172: 'Cessna 172', C152: 'Cessna 152', C182: 'Cessna 182', C208: 'Cessna Caravan', C25A: 'Citation CJ2',
    C25B: 'Citation CJ3', C56X: 'Citation Excel', C68A: 'Citation Latitude', C700: 'Citation Longitude', PC12: 'Pilatus PC-12',
    PC24: 'Pilatus PC-24', PA28: 'Piper PA-28', P28A: 'Piper Warrior', SR22: 'Cirrus SR22', DA40: 'Diamond DA40', DA42: 'Diamond DA42',
    DA62: 'Diamond DA62', GLF5: 'Gulfstream G550', GLF6: 'Gulfstream G650', GL7T: 'Bombardier Global 7500', GLEX: 'Global Express',
    CL35: 'Challenger 350', CL60: 'Challenger 600', F2TH: 'Falcon 2000', FA7X: 'Falcon 7X', LJ45: 'Learjet 45',
    EC35: 'Airbus H135', EC45: 'Airbus H145', EC30: 'Airbus H130', EC55: 'Airbus H155', EC75: 'Airbus H175', H160: 'Airbus H160',
    B06: 'Bell 206', R44: 'Robinson R44', R22: 'Robinson R22', AS50: 'Airbus H125', NH90: 'NH90', CH47: 'Chinook', H64: 'Apache',
    EUFI: 'Eurofighter', F35: 'F-35 Lightning', F16: 'F-16', TOR: 'Tornado', C130: 'C-130 Hercules', C30J: 'C-130J',
    C17: 'C-17 Globemaster', K35R: 'KC-135', A332_T: 'A330 MRTT', P8: 'P-8 Poseidon', E3TF: 'AWACS', GLID: 'Segelflugzeug',
    ULAC: 'Ultraleicht', BALL: 'Ballon', UAV: 'Drohne',
  };
  const HELI = /^(EC|H1|H6|AS|B06|B4|R22|R44|R66|NH90|CH47|H64|A1[0-9]9|AW1|S76|S92|MI|KA)/;

  const Db = {
    airline(callsign) {
      const p = String(callsign || '').trim().slice(0, 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(p)) return '';
      return AIRLINES[p] || '';
    },
    typeName(code) { return code ? (TYPES[code.toUpperCase()] || code.toUpperCase()) : ''; },
    isHeli(code, category) { return category === 'A7' || HELI.test(String(code || '').toUpperCase()); },

    // ------------------------------------------------------------ routes (adsb.im)
    routes: new Map(),     // callsign -> {t, from, to, fromName, toName, plausible} or {t, none: true}
    _pending: new Set(),

    /** Route for a callsign from the cache; starts a lookup if unknown (result appears a moment later). */
    route(callsign, lat, lon) {
      const cs = String(callsign || '').trim().toUpperCase();
      if (!/^[A-Z]{3}[0-9A-Z]{1,5}$/.test(cs)) return null;
      const r = this.routes.get(cs);
      if (r && Date.now() - r.t < 6 * 3600 * 1000) return r.none ? null : r;
      if (!this._pending.has(cs)) this._lookup(cs, lat, lon);
      return null;
    },

    async _lookup(cs, lat, lon) {
      this._pending.add(cs);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch('https://adsb.im/api/0/routeset', {
          method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planes: [{ callsign: cs, lat: +lat.toFixed(3), lng: +lon.toFixed(3) }] }),
        });
        clearTimeout(timer);
        const j = r.ok ? await r.json() : [];
        const e = Array.isArray(j) ? j[0] : null;
        if (e && Array.isArray(e._airports) && e._airports.length >= 2) {
          const a = e._airports[0], b = e._airports[e._airports.length - 1];
          this.routes.set(cs, {
            t: Date.now(), plausible: e.plausible !== false,
            from: a.iata || a.icao, to: b.iata || b.icao, fromName: a.location || a.name, toName: b.location || b.name,
          });
        } else {
          this.routes.set(cs, { t: Date.now(), none: true });
        }
      } catch (err) {
        this.routes.set(cs, { t: Date.now() - 5.5 * 3600 * 1000, none: true });   // retry in ~30 min
      }
      this._pending.delete(cs);
    },
  };

  AC.AircraftDb = Db;
})(window.AC = window.AC || {});
