# AeroCallout TAS

Open-Source-Verkehrs-, Gelände- und Wetterwarnsystem mit Sprachansagen im Stil von Luftfahrt-Callouts.
Es läuft als Web-App (PWA) und damit unverändert auf dem Windows-PC (Chrome/Edge) und auf dem iPhone (Safari).

> ⚠️ **Kein zertifiziertes System.** AeroCallout ist weder TCAS/ACAS noch TAWS noch ein Wetterradar und
> ersetzt keine Luftraumbeobachtung. Viele Luftfahrzeuge senden kein ADS-B oder sind nicht im Internet sichtbar
> (Segelflugzeuge, UL, Gleitschirme, FLARM-only). **Es werden bewusst keine Ausweichempfehlungen gegeben.**

## Starten unter Windows

1. Doppelklick auf **`AeroCallout starten.bat`**.
   Es öffnet sich ein Konsolenfenster mit dem lokalen Server und der Browser mit `http://localhost:8787/`.
   Installiert wird nichts, der Server ist ein PowerShell-Skript.
2. **PWR** drücken, den Hinweis bestätigen und den Selbsttest abwarten (Klick auf den Bildschirm überspringt ihn).
3. Zum Testen am Schreibtisch: **SIM** drücken, dann im Reiter **Simulation** eine Startposition und ein
   Szenario wählen. Mit „Echter Live-Verkehr“ siehst du die realen Flugzeuge um die simulierte Position
   (z. B. Frankfurt) und hörst echte Ansagen.

Zum Beenden das Konsolenfenster schließen.

## Funktionen

| Bereich | Umsetzung |
|---|---|
| Verkehr | ADS-B von **adsb.lol** und **adsb.fi**, abwechselnd abgefragt (ca. 1 s effektive Aktualisierung, redundant) |
| Warnlogik | TCAS-II-TA-Kriterien (Tau, DMOD, ZTHR, Sensitivity Level SL2–SL7 nach Höhe), Trajektorienvorhersage inkl. Kurvenrate, Fehlalarmfilter über vorhergesagten Miss-Distance |
| Stufen | ◇ anderer Verkehr · ◆ naher Verkehr · ● **TA** („Traffic“) · ■ **Konflikt** (wiederholt, *ohne* Ausweichempfehlung) |
| Empfindlichkeit | SENS-Taste LO/NORM/HI/MAX (×0,75 … ×1,5), dazu SL fest oder AUTO, Höhenfilter NORM/ABV/BLW/UNR |
| Ansagen | Englisch oder Deutsch. Stil „Traffic! 2 o'clock, high, 3 miles“ (TAS) oder „Traffic, Traffic“ (TCAS). Terrain: „Caution Terrain“, „Terrain, Terrain, Pull up“. Obstacle: „Caution Obstacle“, „Obstacle, Obstacle, Pull up“ |
| Gelände | Höhenkacheln (AWS Terrain Tiles), Vorausschau entlang des Flugwegs (Caution ca. 60 s, Warning ca. 30 s), TERR-Bild im EGPWS-Farbschema, Unterdrückung nahe Flugplätzen |
| Hindernisse | Masten, Türme, Windräder, Hochspannungsleitungen, Seilbahnen aus OpenStreetMap; Seilhöhe zwischen den Stützen interpoliert |
| Wetter | RainViewer-Radar, Farben zurück in dBZ umgerechnet; Anzeige grün/gelb/rot/magenta (20/30/40/50 dBZ), GAIN ±10 dB, ±60°-Sektor mit Sweep oder 360°, Gewittersymbole (Open-Meteo), „WX AHEAD“ |
| Anzeige | 360°- oder ARC-Darstellung, Bereich 2–80 NM bzw. km, Kompassrose, TCAS-Symbolik, Datenschild ±100 ft (metrisch ±10 m), Steig-/Sinkpfeil |
| Optionen (Taste MENU) | Einheiten: NM/km, kt/km/h, ft/m, ft/min / m/s (Schnellwahl Luftfahrt/Metrisch), Sprache, Stil, Warnton, Lautstärke, Tempo, Audio-Test, Warnungen ein/aus, Empfindlichkeit |
| Audio-Robustheit | Stimme passend zur Sprache (lokale Stimmen bevorzugt), automatischer Sprachwechsel, wenn keine Stimme installiert ist, Wiederholung bei Fehlern, Warnton als Rückfallebene, Diagnose im Status („Sprachausgabe“) und „AUDIO FAIL“ im Display |
| Selbsttest | POST-Seite mit echten Prüfungen (GPS, ADS-B, Gelände, WX), Testmuster, Lampentest, „Traffic system test OK“ |
| Simulation | 20 Szenarien (Frontal, Kreuzen, Überholer, Steigen/Sinken, Segelflieger kreisend, mehrere Ziele, Bergrücken, Sinkflug, Mast, Stromleitung, Gewitterzelle/-linie, GPS-/ADS-B-Ausfall …) |

### Maßnahmen für zuverlässige Verkehrsansagen

- **Positionszeit statt Ankunftszeit:** Für jedes Ziel wird die Zeit der Position aus `seen_pos` und der
  Mitte der Anfrage berechnet. Das ist unabhängig von Uhrabweichungen; es wird immer die neueste Position
  aus beiden Quellen verwendet.
- **Koppelnavigation auf „jetzt“** mit Geschwindigkeit, Kurs und *Kurvenrate* (`track_rate`).
- **Unsicherheitsmodell:** NACp bzw. MLAT/TIS-B plus Extrapolationsfehler vergrößern das Schutzvolumen.
  Ziele älter als 12 s werden verworfen, ab 6 s werden sie gedimmt dargestellt.
- **Höhenbezug:** Bevorzugt wird die GNSS-Höhe. Ziele ohne GNSS-Höhe werden über die gelernte Differenz
  zwischen GNSS- und Druckhöhe anderer Flugzeuge in ähnlicher Höhe korrigiert (kompensiert QNH und Temperatur).
  Geschätzte Höhen sind in der Statusliste mit * markiert.
- **Eigener Transponder** wird automatisch erkannt und ausgeblendet; optional kann die eigene ICAO-Adresse
  eingetragen werden.
- **Eigene Position:** Alpha-Beta-Filter, Doppler-Geschwindigkeit des GPS bevorzugt, Kurvenrate geschätzt.
- **Hysterese:** TA bleibt 10 s stehen, Konflikt 4 s, damit nichts flackert. Eine TA wird nur einmal angesagt
  (wie bei TCAS); bei Eskalation zur Konfliktwarnung erfolgt eine neue Ansage.
- **Priorisierung:** Terrain/Obstacle-Warnung > Verkehrskonflikt > Cautions > TA. Während einer
  Geländewarnung werden Verkehrsansagen unterdrückt (wie bei TCAS/EGPWS).
- **Ausfallerkennung:** GPS FAIL, TFC FAIL (keine Daten seit 15 s), TERR N/A, WX N/A.

### Bekannte Grenzen

- Internetdaten haben 1–3 s Latenz und Abdeckungslücken in Bodennähe. Mit einem ADS-B-Empfänger an Bord wäre
  die Erkennung deutlich zuverlässiger.
- Desktop-Browser liefern über WLAN-Ortung nur grobe Positionen ohne Geschwindigkeit. Für echten Betrieb ist
  ein Gerät mit GPS nötig; zum Testen gibt es den Simulator.
- Das Wetterradar ist 3–10 min alt (RainViewer kostenlos, max. Zoomstufe 7 ≈ 1 km). Gewitter stammen aus einem
  Wettermodell, nicht aus Blitzortung.
- OpenStreetMap-Hindernisse sind unvollständig, und der öffentliche Overpass-Server ist zeitweise überlastet.
- iPhone: Safari pausiert Web-Apps bei gesperrtem Bildschirm. Die App hält den Bildschirm wach (Wake Lock);
  Ansagen kommen nur bei aktiver App. Für Hintergrundbetrieb müsste sie als native App verpackt werden
  (z. B. Capacitor).

## Auf dem iPhone nutzen

Die App braucht HTTPS (für GPS) und für ADS-B einen Proxy, weil adsb.lol und adsb.fi keine CORS-Header senden:

1. Den Ordner auf einen HTTPS-Webspace laden (z. B. GitHub Pages, Netlify).
2. `proxy/cloudflare-worker.js` als Cloudflare Worker deployen (kostenlos) und dessen URL in
   **Einstellungen → Datenquellen → Proxy** eintragen.
3. In Safari öffnen, „Teilen → Zum Home-Bildschirm“.

## Aufbau

```
index.html, css/style.css     Oberfläche (Gerät mit Softkeys + Status/Simulation/Einstellungen)
js/geo.js                     Geodäsie, Bahnvorhersage
js/gps.js                     Geräte-GPS + Filter
js/adsb.js                    ADS-B-Abfrage, Fusion, Höhenkorrektur, Unsicherheit
js/traffic-logic.js           TCAS-artige TA-/Konfliktlogik (ohne RA)
js/terrain.js                 Höhendaten + FLTA
js/obstacles.js               OSM-Hindernisse + Prüfung
js/weather.js                 Radar (dBZ) + Gewitter
js/voice.js                   Ansagen, Priorisierung, Wiederholung
js/display.js                 Cockpit-Anzeige (TCAS/WX/TERR)
js/selftest.js                Einschalt-Selbsttest
js/sim.js                     Simulator + Szenarien
server.ps1                    lokaler Webserver + ADS-B-Proxy (Windows, ohne Installation)
```

## Lizenz & Daten

Code: MIT. Daten: adsb.lol (ODbL), adsb.fi Open Data, AWS Terrain Tiles (Mapzen/SRTM u. a.),
© OpenStreetMap-Mitwirkende (ODbL), RainViewer, Open-Meteo (CC BY 4.0).
