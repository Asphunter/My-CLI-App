# Kimi K3 és DeepSeek V4 Flash integrációs kutatás és implementációs terv

*Kutatási állapot: 2026-08-02 · csak terv, ebben a körben nincs kódimplementáció*

## Rövid döntés

Mindkét modell integrálható a Minbe, de **külön Kimi és DeepSeek providerként**.
Egyik sem Anthropic-modell. Az „Anthropic-kompatibilis” kifejezés ebben a
dokumentumban kizárólag egy támogatott hálózati üzenetformátumot jelent, ugyanúgy,
ahogy az „OpenAI-kompatibilis” sem teszi a modellt OpenAI-modellé.

A javasolt irány:

1. A Min provider-azonosságát, a használt protokollt és a futtató runtime-ot
   három külön fogalomra kell bontani.
2. Elsőként provider-semlegessé kell tenni a jelenleg bináris Codex/Claude
   architektúrát, változatlan meglévő működés mellett.
3. Ezután külön, rövid kompatibilitási próbával ellenőrizni kell a már meglévő
   agent bridge használhatóságát a két szolgáltató Anthropic-formátumú
   endpointján. Ez gyorsíthatja az MVP-t, de a GUI-ban és az adattárolásban ettől
   még Kimi és DeepSeek marad a provider.
4. A hosszú távon tiszta „raw” út egy közös OpenAI Chat Completions adapter,
   amely a Kimi Open Platform és a DeepSeek közvetlen API-ját is kezeli. Ehhez
   saját agent loop, tool-call végrehajtás és sessiontárolás kell.
5. A Kimi esetén két, egymással nem felcserélhető hozzáférés legyen:
   **Kimi Code előfizetés** és **Kimi Open Platform API**. A DeepSeeknél jelenleg
   a dokumentált fejlesztői út **feltöltött egyenlegű, tokenalapú API**, nem havi
   API-előfizetés.

Az integráció tehát nem egyszerű „két modellnév hozzáadása”. A modellválasztó
mellett a hitelesítést, provider-routingot, sessionkulcsokat, effort-kezelést,
pipeline stage-eket és a LIVE eseményeket is provider-semlegessé kell tenni.

## Mit jelent itt a „raw” használat?

Ebben a tervben a „raw” azt jelenti, hogy a Min közvetlenül a modellgazda
hivatalos API-ját hívja a felhasználó saját API-kulcsával. Nincs köztes
aggregátor, modellrouter, böngészőautomatizálás vagy másik szolgáltatás
előfizetésének megjátszása.

Három külön használati forma van:

| Forma | Ki végzi az agentmunkát? | Fizetés | Min szempontjából |
| --- | --- | --- | --- |
| Web/app chat | A szolgáltató saját webes terméke | ingyenes/előfizetés | Nem stabil integrációs felület |
| Coding előfizetés | Kimi Code és támogatott coding kliens | tagsági kredit/kvóta | Kimihez lehetséges, külön credential és endpoint |
| Raw API | A Min küldi az üzeneteket és kezeli a tool loopot | tokenalapú API-egyenleg | A legtisztább, providerfüggetlen integráció |

## Hivatalos szolgáltatási kép

### Kimi K3

#### A modell

- Open Platform modellazonosító: `kimi-k3`.
- Kimi Code modellazonosítók: `k3` és `k3-256k`.
- A K3 legfeljebb 1M tokenes kontextust támogat, natív képértéssel.
- Mindig thinking módban működik; natív effortjai: `low`, `high`, `max`, az
  Open Platform alapértéke `max`.
- Támogatott a streaming, tool call, JSON mód, structured output és az
  automatikus context cache.

Források: [Kimi API modellválasztás](https://www.kimi.com/help/kimi-api/api-model-selection),
[Kimi K3 API hibaelhárítás](https://www.kimi.com/help/kimi-api/api-troubleshooting),
[Kimi Code modellek](https://www.kimi.com/code/docs/en/kimi-code/models.html).

#### 1. Kimi Open Platform: közvetlen, raw API

- Nem előfizetés, hanem pay-as-you-go API.
- Nemzetközi platform: `platform.kimi.ai`.
- Nemzetközi base URL: `https://api.moonshot.ai/v1`.
- OpenAI Chat Completions-kompatibilis.
- A K3 legalább 1 USD sikeres feltöltés után nyílik meg.
- A kulcs és az egyenleg régióhoz kötött; a kínai és a nemzetközi platform
  kulcsai nem keverhetők.
- A Kimi Code-kulcs nem használható ezen az endpointon.

A 2026-08-02-án publikált hivatalos K3 árak 1M tokenre:

| Tétel | Ár |
| --- | ---: |
| Cache hit input | 0,30 USD |
| Cache miss input | 3,00 USD |
| Output | 15,00 USD |

A webes keresés dokumentált felára 0,004 USD/hívás, de a Kimi saját
hibaelhárító oldala egyszerre nevezi frissítés alatt állónak és írja le a
`$web_search` használatát. Emiatt a beépített Kimi web search ne legyen az első
release része.

Források: [Kimi API áttekintés](https://www.kimi.com/help/kimi-api/api-overview),
[Kimi API árképzés](https://www.kimi.com/help/kimi-api/api-pricing),
[Kimi K3 árak](https://www.kimi.com/resources/kimi-k3-pricing),
[Kimi API hibaelhárítás](https://www.kimi.com/help/kimi-api/api-troubleshooting).

Raw HTTP alak, szemléltetésként:

```http
POST https://api.moonshot.ai/v1/chat/completions
Authorization: Bearer <KIMI_OPEN_PLATFORM_API_KEY>
Content-Type: application/json

{
  "model": "kimi-k3",
  "messages": [{"role": "user", "content": "Válaszolj csak ennyit: OK"}],
  "reasoning_effort": "high",
  "stream": true
}
```

Ez csak modellhívás. A fájlolvasást, írást, shellt, Todo/LÉPÉSEK állapotot,
jóváhagyást és a többkörös tool loopot a Minnek kell hozzáadnia.

#### 2. Kimi Membership + Kimi Code: előfizetéses út

A jelenlegi havi csomagok:

| Csomag | Havi | Éves díj havi megfelelője | Kimi Code kredit-szorzó |
| --- | ---: | ---: | ---: |
| Moderato | 19 USD | 15 USD | 1× |
| Allegretto | 39 USD | 31 USD | 5× |
| Allegro | 99 USD | 79 USD | 15× |
| Vivace | 199 USD | 159 USD | 30× |

Az ingyenes Adagio csomaghoz a jelenlegi árlista nem ad Kimi Code kreditet.
A Kimi Code külön 5 órás/heti limitekkel is működik; a dokumentáció csomagtól
függően körülbelül 300–1200 kérést említ 5 órás ablakonként, legfeljebb 30
párhuzamos streammel. A kredit- és limitrendszer gyorsan változik, ezért a Min
ne kódolja be fixen a csomagjogosultságot.

Jelenlegi jogosultságok a coding dokumentáció szerint:

- Moderato: `k3`, `k3-256k`, `kimi-for-coding`, legfeljebb 256K kontextussal.
- Allegretto és fölötte: `k3` legfeljebb 1M kontextussal, valamint a többi
  coding modell és a HighSpeed opció.
- `k3-256k` ugyanazt a K3 képességet célozza kisebb kontextusban, és a
  dokumentáció szerint hozzávetőleg fele akkora kvótát fogyaszt, mint az 1M K3.

Kimi Code API:

| Protokoll | Base URL | Modellnév |
| --- | --- | --- |
| OpenAI-kompatibilis | `https://api.kimi.com/coding/v1` | `k3` vagy `k3-256k` |
| Anthropic-kompatibilis | `https://api.kimi.com/coding/` | `k3` vagy `k3-256k` |

A Kimi Code saját API-kulcsot ad a Kimi Code Console-ban. Ez nem azonos az Open
Platform kulcsával. A tagsági kreditek elfogyása után külön Extra Usage egyenleg
kapcsolható be; ez használatalapú, külön költési plafonnal.

Források: [Kimi membership árak](https://www.kimi.com/help/membership/membership-pricing),
[Kimi Code membership](https://www.kimi.com/help/kimi-code/membership-guide),
[Kimi Code áttekintés és endpointok](https://www.kimi.com/code/docs/en/),
[Kimi Code Claude Code konfiguráció](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html),
[Kimi Code benefits és Extra Usage](https://www.kimi.com/help/kimi-code/benefits).

#### Kimi előfizetéses bizonytalanság

A Kimi dokumentáció engedélyezi harmadik fél fejlesztői eszközeinek bekötését,
de külön hangsúlyozza a kliens valós identitásának/User-Agentjének megtartását,
és egyes help-oldalak szűkebb támogatott klienslistát közölnek. A Min ezért:

- nem adhatja ki magát Claude Code-nak, Codexnek vagy Kimi CLI-nek;
- `Min/<verzió>` kliensazonosítót küldjön;
- a Kimi Code út induljon `experimental` jelöléssel;
- production engedélyezés előtt élő connection/tool teszt és szükség esetén
  írásos Kimi support-megerősítés kell arra, hogy a saját Min kliens tagsági
  API-kulccsal elfogadott felhasználás.

### DeepSeek V4 Flash

#### A modell és a raw API

- Hivatalos modellazonosító: `deepseek-v4-flash`.
- OpenAI formátumú base URL: `https://api.deepseek.com`.
- Anthropic formátumú base URL: `https://api.deepseek.com/anthropic`.
- Kontextus: 1M token; dokumentált maximális output: 384K token.
- Thinking és non-thinking módot is támogat; thinking az alapérték.
- Natív reasoning effort: `high` és `max`.
- A kompatibilitási mappingben a `low` és `medium` is `high`, az `xhigh` pedig
  `max`; ezeket a Min ne mutassa külön képességként.
- Tool calls, JSON output, streaming és Chat Prefix támogatott.
- A régi `deepseek-chat` és `deepseek-reasoner` aliasok 2026-07-24-én kifutottak;
  a Min kizárólag az explicit `deepseek-v4-flash` ID-t használja.

A 2026-08-02-án dokumentált árak 1M tokenre:

| Tétel | Ár |
| --- | ---: |
| Cache hit input | 0,0028 USD |
| Cache miss input | 0,14 USD |
| Output | 0,28 USD |

A dokumentált account-szintű párhuzamossági limit Flash esetén 2500. Ha egy
kérés 10 percen belül nem kezdi el az inference-t, a provider lezárhatja a
kapcsolatot. Ez távoli szolgáltatói limit, nem a Min saját turn-timeoutja.

Források: [DeepSeek modellek és árak](https://api-docs.deepseek.com/quick_start/pricing),
[DeepSeek V4 bejelentés](https://api-docs.deepseek.com/news/news260424/),
[DeepSeek modelllista](https://api-docs.deepseek.com/api/list-models),
[DeepSeek rate limit](https://api-docs.deepseek.com/quick_start/rate_limit).

Raw HTTP alak, szemléltetésként:

```http
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <DEEPSEEK_API_KEY>
Content-Type: application/json

{
  "model": "deepseek-v4-flash",
  "messages": [{"role": "user", "content": "Válaszolj csak ennyit: OK"}],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "stream": true
}
```

#### DeepSeek előfizetés és fizetés

A hivatalos API-dokumentáció jelenleg nem kínál a Claude/Kimi Code jellegű havi
API-előfizetést. A fejlesztői fiók feltöltött egyenlegből fizet:

- támogatott feltöltési módok: PayPal, bankkártya, Alipay, WeChat Pay;
- a feltöltött egyenleg nem jár le;
- a fel nem használt feltöltött egyenleg visszatéríthető;
- a `chat.deepseek.com` webes Expert/Instant mód külön termékélmény, nem raw API
  credential és nem szabad abból automatizált integrációt építeni.

Forrás: [DeepSeek FAQ](https://api-docs.deepseek.com/faq).

#### Kritikus DeepSeek tool-loop szabály

Thinking módban, ha az assistant tool callt adott, a hozzá tartozó teljes
`reasoning_content` mezőt minden következő kérésben vissza kell küldeni. Ha ez
kimarad, az API 400 hibát ad. Ez nem UI-részlet: a session/message store
sémájának meg kell őriznie ezt az adatot legalább az aktuális tool loop végéig.

Forrás: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).

## Képességmátrix

| Tulajdonság | Kimi Open API | Kimi Code | DeepSeek API |
| --- | --- | --- | --- |
| Provider a GUI-ban | Kimi | Kimi | DeepSeek |
| Fizetési mód | tokenalapú PAYG | előfizetés + opcionális Extra Usage | feltöltött PAYG egyenleg |
| Elsődleges protokoll | OpenAI Chat Completions | OpenAI vagy Anthropic formátum | OpenAI vagy Anthropic formátum |
| Modell ID | `kimi-k3` | `k3`, `k3-256k` | `deepseek-v4-flash` |
| Kontextus | 1M | 256K vagy csomagtól függően 1M | 1M |
| Thinking | mindig be | mindig be K3-nál | be/ki |
| Natív effort | Low / High / Max | Low / High / Max | High / Max |
| Kép input | igen | route/modell függő, élő teszt kell | Anthropic kompatibilis API-n nem támogatott; alapból kikapcsolandó |
| Tool call | igen | igen | igen |
| Provider-oldali agent session | nincs garantálva, Min kezeli | kliens/runtime függő | nincs garantálva, Min kezeli |
| Minen belüli kliensjogosultság | tiszta custom API use case | feltételesen igazolandó | tiszta custom API use case |

## A Min jelenlegi architektúrájának diagnózisa

### Ami már jó alap

- A `src-tauri/src/agent.rs` már közös `AgentTurnRequest`,
  `AgentEventEnvelope`, `AgentResponse`, capability- és modelldescriptor
  szerződést használ.
- A `src-tauri/src/lib.rs` egy közös `agent_send` belépési ponton futtatja a
  normál turnt és a pipeline stage-et.
- A TERV/KÓD/REVIEW toolprofilok provider-semleges fogalomként már léteznek.
- A LIVE GUI közös normalizált eseményeket fogyaszt, így nem kell külön Kimi és
  DeepSeek teljes nézetet építeni.
- A Windows Credential Managerhez már van `keyring` infrastruktúra.
- A turn- és sessiontáblák szövegként tárolják a providert/runtime-ot, tehát az
  adatmodell bővíthető anélkül, hogy új adatbázist kellene kezdeni.

### Ami ma kifejezetten kétprovideres és átírandó

1. `src-tauri/src/agent.rs`
   - `AgentProvider` csak `Codex | Anthropic`.
   - `AgentRuntimeKind` csak `CodexAppServer | ClaudeAgentBridge`.
   - A modellkatalógus Claude modelljeit és effortjait beégetve tartalmazza.
2. `src-tauri/src/lib.rs`
   - A dispatch, cancel, approval, question, auth, modellista és connection test
     kétágú `match`.
3. `src-tauri/src/claude.rs`
   - Claude subscriptiont keres, Claude API-kulcs keyring-slotot használ,
     Anthropic env változókat állít és minden eseményt Anthropic/Claude
     identitással bocsát ki.
4. `agent-bridge/main.mjs`
   - A Claude Agent SDK-t használja, és a bridge payloadjaiban beégetett
     `anthropic`/`claudeAgentBridge` azonosítók vannak.
5. `src/App.tsx`
   - A modellnév `claude-` prefixéből találja ki a providert.
   - `selectedClaudeModel` és `useClaude` booleannal route-ol.
   - A modellcsaládok és a Multi-AI stage-modellek két vendorra fixek.
   - Minden stage effortja a közös ötelemű fallback-listát kapja a modell valós
     képessége helyett.
6. `src/runInput.ts`
   - A futás közbeni chat provider típusa csak `codex | anthropic`.
7. `src-tauri/src/store.rs`
   - A provider wire mapping kétágú.
   - A SessionStore stabil ID-jában és insertjében konkrétan az `anthropic`
     szó szerepel. Kimi és DeepSeek sessionök így ütközhetnének vagy rossz
     provider alá kerülnének.

## Célarchitektúra

### 1. Provider, protokoll és runtime szétválasztása

Javasolt belső modell:

```text
ProviderIdentity
├── Codex
├── Claude
├── Kimi
└── DeepSeek

TransportProtocol
├── CodexAppServer
├── AnthropicMessages
└── OpenAiChatCompletions

AgentRuntime
├── CodexAppServerRuntime
├── ClaudeAgentSdkRuntime
└── OpenAiCompatAgentRuntime
```

Egy Kimi kérés tehát például:

```text
provider = Kimi
protocol = AnthropicMessages
runtime = ClaudeAgentSdkRuntime
accessProfile = kimiCodeSubscription
```

vagy:

```text
provider = Kimi
protocol = OpenAiChatCompletions
runtime = OpenAiCompatAgentRuntime
accessProfile = kimiOpenPlatform
```

Az első esetben a runtime technikailag újrahasznál egy Anthropic-formátumot
beszélő SDK-t. Ettől a modell, a provider, a számlázás és a session továbbra is
Kimi. A GUI-ban sehol nem jelenhet meg Claude néven.

### 2. Provider profile legyen az egyetlen igazságforrás

Új `ProviderProfile`/`ModelProfile` registry tartalmazza:

- provider ID és megjelenített név;
- hozzáférési profil ID;
- fix hivatalos base URL;
- protokoll és runtime;
- keyring credential slot;
- modell API ID és megjelenített név;
- context/output limitek;
- thinking módok és valódi effortlista;
- image/tool/question/approval/session/steering képességek;
- ármetaadatok csak tájékoztató jelleggel és `checkedAt` dátummal;
- provider dokumentáció linkje.

Az alap endpointok ne legyenek tetszőlegesen szerkeszthetők az első verzióban.
Ez megakadályozza, hogy egy elgépelt vagy rosszindulatú endpointnak küldjük az
API-kulcsot. „Custom OpenAI endpoint” külön, későbbi funkció legyen.

### 3. Credential profilok

Külön Windows Credential Manager bejegyzések:

```text
min-local-ai-workspace / claude-api-key
min-local-ai-workspace / kimi-code-api-key
min-local-ai-workspace / kimi-open-platform-api-key
min-local-ai-workspace / deepseek-api-key
```

Szabályok:

- kulcs soha nem kerül SQLite-ba, localStorage-ba, Tauri payload logba,
  parancssori argumentumba vagy PLAN fájlba;
- a child process csak az adott turnhöz szükséges egyetlen credentialt kapja;
- provider váltáskor minden idegen auth env változót explicit törölni kell;
- a Claude subscription automatikus felismerése kizárólag Claude-ra vonatkozik;
- a Kimi Code és Kimi Open Platform kulcs felülete egyértelműen külön legyen;
- connection test mutassa a route nevét, base URL hostját, modellt és a kulcs
  maszkolt előnézetét, de a teljes kulcsot soha.

### 4. Modell- és effort-UI

Nem prefixből kell providert találni. Minden modellhez explicit `providerId` és
`accessProfileId` tartozzon.

Javasolt opciók:

- Kimi K3 Open API: `Low | High | Max`.
- Kimi K3 Kimi Code: `Low | High | Max`.
- DeepSeek V4 Flash: `Off | High | Max`, ahol az `Off` non-thinking módot jelent.

A DeepSeek `Low` és `Medium` nem külön erősség, mert a provider `High`-ra mapeli;
az `XHigh` pedig ugyanaz, mint a `Max`. Ezek megjelenítése hamis választási
lehetőséget adna.

A jelenlegi három felület ugyanabból a registryből épüljön:

1. nem-Részletes normál mód;
2. Részletes EGY-AI mód;
3. Részletes MULTI-AI TERV/KÓD/REVIEW és TERV/REVIEW mód.

Multi-AI esetén minden oszlopban külön provider → access profile → model →
effort lánc legyen. Provider vagy access profile váltásakor a nem kompatibilis
modell/session ne öröklődjön át.

### 5. Session és conversation kezelés

- A session stabil kulcsa tartalmazza a `conversationId`, `providerId`,
  `accessProfileId` és `providerSessionId` értékeket.
- A régi Anthropic sorok változatlanul olvashatók maradnak.
- Direkt Chat Completions útvonalon a Min a kanonikus üzenet- és tooltörténet
  tulajdonosa; a providernek nincs feltételezett server-side sessionje.
- Kimi/DeepSeek session nem resume-olható Claude-ként, még akkor sem, ha ugyanaz
  a kompatibilis protokoll/runtime vitte a kérést.
- Modell-, provider- vagy Kimi access-profile váltás új provider-sessiont kezd.
- A DeepSeek tool callhoz tartozó `reasoning_content` megőrzése kötelező.

### 5/A. Provider-specifikus request mapping

A közös UI-értékekből az adapter készítse el a route valódi wire paramétereit;
ne a frontend küldjön protokollspecifikus JSON-t.

| Provider/route | UI választás | Wire viselkedés |
| --- | --- | --- |
| Kimi Open Platform | Low / High / Max | top-level `reasoning_effort: low/high/max`; thinking nem kapcsolható ki |
| Kimi Code OpenAI-formátum | Low / High / Max | K3 modell + route által dokumentált effort mapping; thinking mindig bekapcsolva |
| Kimi Code Anthropic-formátum | Low / High / Max | SDK effort mapping, K3-at kikapcsoló/`none` mód tiltva |
| DeepSeek OpenAI-formátum | Off | `thinking.type: disabled`, reasoning effort nélkül |
| DeepSeek OpenAI-formátum | High / Max | `thinking.type: enabled` + `reasoning_effort: high/max` |
| DeepSeek Anthropic-formátum | Off | thinking kikapcsolása az endpoint által elfogadott mezővel |
| DeepSeek Anthropic-formátum | High / Max | `output_config.effort: high/max` |

A jelenlegi `agent-bridge/main.mjs` minden Claude turnnél
`thinking: { type: "adaptive" }` értéket állít be. Ez nem maradhat közös,
beégetett viselkedés: a Kimi K3 mindig-thinking modell, a DeepSeek pedig külön
be/ki módot és csak High/Max effortot ad. A runtime a kiválasztott
`ProviderProfile` alapján építse fel az SDK/API opciókat.

### 6. Toolok és TERV/KÓD/REVIEW

A Min jelenlegi stage toolprofiljai maradjanak a policy forrásai:

| Stage | Engedély |
| --- | --- |
| TERV | read-only: olvasás/keresés, nincs írás vagy shell |
| TERV REVIEW | read-only |
| KÓD | teljes fájl- és parancseszközkészlet approvallal |
| REVIEW | olvasás és tesztparancs, nincs fájlírás |

A provider csak tool requestet kérhet; a tényleges fájl- és shellműveletet a Min
helyi policyrétege engedélyezi és hajtja végre. Provider-specifikus prompt nem
lehet biztonsági kontroll.

A KÓD LÉPÉSEK működéséhez minden runtime-nak azonos Todo/plan-state toolt kell
látnia. Nem fogadható el az, hogy Kimi vagy DeepSeek csak szövegben ígéri a
lépéseket; ugyanazokat a strukturált `plan/updated` eseményeket kell küldenie a
GUI felé, mint a működő Codex/Claude út.

### 7. LIVE események és gondolkodás

Provideradapter → közös `AgentEventEnvelope` mapping:

- text delta → `agent/text_delta`;
- reasoning delta/summary → `agent/reasoning_delta`;
- tool call start/update/result → közös tool események;
- Todo frissítés → `plan/updated`;
- fájlművelet → közös LIVE KÓD esemény, valós sorszámokkal;
- token/cost → usage esemény;
- terminal állapot → completed/failed/cancelled.

A `provider` mindig `kimi` vagy `deepseek`, a `runtime` pedig a tényleges
futtató. A GONDOLKODÁS MENETE a provider által ténylegesen kiadott reasoninget
vagy reasoning summaryt mutatja; nem szabad belső gondolatot kitalálni.

### 8. Futás közbeni chat

- A Claude Agent SDK kompatibilitási útvonalán külön próbálni kell, hogy a
  jelenlegi `streamInput(... priority: now)` valóban átjut-e Kimihez/DeepSeekhez.
- Direkt Chat Completionsnél nincs szabványos „módosítsd a már futó generálást”
  API. Ott a terelés legkorábban a következő tool-loop határon kézbesíthető.
- A capability registry ezt őszintén jelezze: `native`, `loopBoundary` vagy
  `followUpOnly`. A UI ne állítsa, hogy egy üzenet azonnal bejutott, ha csak
  sorban áll.

### 9. Timeout, keep-alive, cancel és retry

- A Min ne vezessen be turn- vagy stage-timeoutot.
- A provider saját távoli korlátait nem lehet kikapcsolni: Kimi körülbelül 2
  órás request-limitet dokumentál; a DeepSeek 10 perc inference-várakozás után
  lezárhatja a kapcsolatot.
- Az SSE parser fogadja a Kimi streamet és a DeepSeek `: keep-alive`
  kommentjeit is.
- Cancelkor az HTTP stream/AbortController azonnal záródjon, a már elkészült
  szöveg és tool/fájl esemény maradjon meg, a turn `MEGSZAKÍTVA` legyen.
- 429/5xx retry exponenciális backoffal csak biztonságos ponton történjen.
  Tool side effect után vak automatikus újrajátszás tilos, mert ugyanazt a
  parancsot vagy írást kétszer hajthatná végre.

### 10. Költség- és budget-szemantika

A mostani Claude `maxBudgetUsd` nem vihető át változtatás nélkül. A Claude Agent
SDK képes saját agent budgetet kezelni, míg a közvetlen Chat Completions API-k
elsősorban tokenlimitet és account/project spending limitet adnak.

Javasolt közös modell:

- `maxOutputTokens`: valódi, requestben érvényesített korlát;
- `softTurnBudgetUsd`: előzetes tokenbecslésből és addigi usage-ből számolt
  figyelmeztetési/megállási határ;
- `providerSpendingLimit`: csak státusz/link, a provider konzoljában beállított
  valódi account- vagy projektlimit;
- `maxAgentIterations`: loop-védelem, nem időkorlát.

A Kimi Open Platform dokumentál projekt napi spending limitet, de a számlázási
adatok késhetnek, ezért a Min soft budgetje nem nevezhető pénzügyi garanciának.
DeepSeeknél a response usage alapján számolható becslés; mindig a provider
számlázása az elszámolási igazság.

## Két lehetséges runtime-út

### A. Kompatibilitási adapter — gyors MVP/spike

A meglévő Claude Agent SDK bridge paraméterezhető:

- külön provider ID és runtime ID;
- külön base URL és auth változó;
- külön modell és effort mapping;
- külön credential resolver;
- provider-semleges event payloadok és hibaszövegek;
- valós `Min/<verzió>` kliensazonosító.

Előny:

- a fájl-, shell-, approval-, question-, Todo-, session- és stream agent loop
  nagy része már kész;
- a DeepSeek és a Kimi Code hivatalosan dokumentál Anthropic-formátumú
  endpointot és Claude Code kompatibilitást.

Kockázat:

- a Min Claude **Agent SDK-t** használ, nem a Claude Code CLI-t; a kettő
  kompatibilitása nem automatikusan azonos;
- provider-specifikus, figyelmen kívül hagyott mezők eltérő tool- vagy
  sessionviselkedést okozhatnak;
- a Kimi Open Platform raw endpoint nem dokumentált Anthropic endpoint, így ez
  az út csak Kimi Code-hoz használható;
- egy SDK update bármikor módosíthatja a third-party endpoint kompatibilitást.

Következtetés: gyors technikai bizonyításra és opcionális MVP-re jó, de csak az
alábbi teljes capability probe után kapcsolható be.

### B. Natív OpenAI Chat Completions agent runtime — végleges raw út

Új provider-semleges bridge:

```text
Min/Tauri
  ↕ provider-semleges JSONL/RPC
OpenAiCompatAgentRuntime
  ↕ SSE Chat Completions
Kimi Open Platform vagy DeepSeek API
```

Feladatai:

- streaming content/reasoning/tool-call fragmentek összerakása;
- tool schema küldése és argumentumvalidálás;
- approval után helyi tool végrehajtás;
- tool result visszaküldése;
- Todo/LÉPÉSEK és LIVE KÓD eventek kibocsátása;
- többkörös loop és stop-feltételek;
- cancellation, retry és usage accounting;
- session history és context compaction;
- DeepSeek `reasoning_content` szabály;
- Kimi ismétlődő tool-call loop felismerése.

Előny: nincs Claude-kódhoz kötve, mindkét raw API valódi saját identitással
működik. Hátrány: ez már teljes coding-agent adapter, nem néhány HTTP hívás.

### C. Kimi CLI/ACP — kutatási tartalékút

A hivatalos Kimi CLI kínál `kimi acp` és lokális server interfészt. Ez később
jó Kimi-specifikus runtime lehet, de az első implementáció előtt külön ki kell
mérni:

- az ACP eventekből kinyerhető-e a Min összes LIVE eseménye;
- működik-e session resume, cancel és futás közbeni input;
- átadható-e maradéktalanul a Min TERV/KÓD/REVIEW toolpolicy;
- mennyire stabil Windows/Tauri child processként.

Amíg ez nincs bizonyítva, ne tegyük a core architektúra függőségévé.

## Implementációs fázisok

### Fázis 0 — élő, kulcsos protokoll-probe, GUI nélkül

Külön diagnosztikai script, amely nem módosít projektfájlt:

1. `GET /models` a megfelelő kulccsal és endpointtal.
2. Rövid streamelt text válasz.
3. Reasoning + effort ellenőrzés.
4. Egy read-only tool call.
5. Többkörös tool call.
6. Kézi cancellation.
7. 401, 402/insufficient balance, 429 és rossz modell kezelése.
8. Kimi Code esetén valós Min kliensazonosítóval ellenőrzés.

Kimenet: redaktált JSONL fixture-ek a parsertesztekhez. Sem API-kulcs, sem teljes
érzékeny prompt nem kerülhet fixture-be.

Go/no-go:

- ha a Claude Agent SDK út minden kötelező tool- és sessionpróbát teljesít,
  használható MVP runtime-ként;
- ha nem, közvetlenül a natív OpenAI-kompatibilis runtime következik.

### Fázis 1 — provider-semleges refaktor, új modell nélkül

Érintett fő fájlok:

- `src-tauri/src/agent.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/store.rs`
- `src/runInput.ts`
- `src/App.tsx`
- `agent-bridge/main.mjs`

Feladatok:

1. Provider/protocol/runtime típusok szétválasztása.
2. Registry-alapú modell- és capability katalógus.
3. Provider-semleges dispatch, cancel, approval, question, auth és test API.
4. A SessionStore provider/access-profile scope-jának javítása.
5. Frontend prefix- és boolean-alapú providerlogika eltávolítása.
6. Pipeline stage choice a registryből.
7. Régi Claude/Codex adatok és localStorage preferenciák migrációja.

Elfogadás: minden meglévő Codex/Claude teszt változatlanul zöld, a GUI még nem
mutat Kimit vagy DeepSeeket.

### Fázis 2 — provider credential és Settings UI

1. Kimi Code, Kimi Open Platform és DeepSeek külön kártya.
2. Mentés/törlés keyringbe.
3. Route-specifikus kapcsolat-teszt.
4. Modelllista/probe és érthető hibaosztályozás.
5. Kimi esetén hozzáférési mód választó:
   `Kimi Code előfizetés` / `Open Platform API`.
6. DeepSeeknél egyértelmű szöveg: `feltöltött API-egyenleg`, nem előfizetés.

### Fázis 3 — DeepSeek V4 Flash

1. Először a sikeres Fázis 0 eredménye szerinti runtime.
2. Explicit `deepseek-v4-flash` modell ID.
3. `Off | High | Max` thinking/effort.
4. `reasoning_content` megőrzése tool loopban.
5. DeepSeek keep-alive és remote wait-limit kezelése.
6. Képattachment tiltása világos UI-üzenettel, amíg az adott API route-on nincs
   hivatalosan és élő próbával igazolva.

### Fázis 4 — Kimi Code előfizetés

1. `k3` és `k3-256k` modellek.
2. `Low | High | Max` effort.
3. Csomagfüggő context limitet ne találjuk ki; connection/model probe eredménye
   legyen mérvadó.
4. Kvóta-/tagsághiba külön üzenetként jelenjen meg.
5. Valós Min kliensazonosító és terms gate.
6. A GUI egyértelműen jelezze: ez Kimi Code kredit, nem Kimi Open API-egyenleg.

### Fázis 5 — Kimi Open Platform raw API

1. `kimi-k3` modell.
2. Nemzetközi `api.moonshot.ai` endpoint; régiókeverés elleni validáció.
3. Natív OpenAI Chat Completions agent loop.
4. Automatikus cache/usage adatok megjelenítése.
5. Projekt napi költési limitjére mutató beállítási segítség.
6. Beépített web search kihagyása az első verzióból.

### Fázis 6 — teljes pipeline és LIVE kompatibilitás

Minden provider/access route-on:

- normál nem-Részletes VÁLASZ;
- Részletes EGY-AI;
- MULTI-AI TERV → KÓD → REVIEW;
- MULTI-AI TERV → REVIEW;
- v2 review-javítás;
- LÉPÉSEK mozgása és Todo mapping;
- LIVE KÓD és FÁJLOK/VÁLTOZÁSOK;
- approval, user question, cancel, restart/resume;
- futás közbeni chat a deklarált capability szerint.

### Fázis 7 — költség, diagnosztika és fokozatos kiadás

- Turnönként input/cache/output token és becsült költség.
- Provider oldali request ID a diagnosztikában.
- Kimi access profile és DeepSeek thinking mód naplózása, kulcs nélkül.
- Soft per-turn költségfigyelmeztetés és provideroldali spending-limit link.
- Experimental flag → opt-in beta → alapból elérhető állapot csak stabil
  valós projekttesztek után.

## Kötelező tesztmátrix

### Protokolltesztek

- SSE chunk kettévágott UTF-8 karakterrel.
- Több részletben érkező tool name/arguments.
- Üres content + reasoning.
- Reasoning + tool call + tool result + végső answer.
- DeepSeek hiányzó/megtartott `reasoning_content` regresszióteszt.
- Kimi ismétlődő tool-call loop korlátozás.
- Provider keep-alive események.
- 401/402/404/429/500/503/504.
- stream közbeni cancel.

### Biztonsági tesztek

- TERV és TERV REVIEW nem írhat fájlt.
- REVIEW nem írhat fájlt, de a runtime-képesség szerint tesztelhet.
- KÓD írás/shell approvalt kér a jelenlegi szabályok szerint.
- Kulcs nem látható frontend state dumpban, logban, child argv-ben vagy SQLite-ban.
- Egy provider child processze nem örökli másik provider credentialjét.
- Rossz/custom base URL nem kaphat beépített credentialt.

### Session és sync tesztek

- azonos beszélgetésben Kimi ↔ DeepSeek ↔ Claude váltás;
- Kimi Code ↔ Kimi Open Platform váltás;
- app restart és kétgépes OneDrive sync;
- session ID-k provider szerint nem ütköznek;
- régi `anthropic` sessionök továbbra is resume-olhatók;
- megszakított turn részleges válasza megmarad és nem kap kész pipát.

### GUI tesztek

- mindhárom mód ugyanazokat a provider/model opciókat kínálja;
- Multi-AI minden oszlopában önálló provider/model/effort;
- DeepSeek nem mutat ál-Low/Medium/XHigh fokozatokat;
- Kimi route neve és számlázási módja látható;
- providerhiba nem Claude-hibaként jelenik meg;
- Kimi/DeepSeek gondolkodás, LÉPÉSEK és LIVE KÓD ugyanazt a közös panelt tölti.

## Elfogadási kritériumok

Az integráció akkor tekinthető késznek, ha:

1. Kimi és DeepSeek külön providerként látszik, Claude megnevezés nélkül.
2. A megfelelő saját kulccsal a connection test és egy teljes coding turn is
   működik.
3. TERV, KÓD és REVIEW toolpolicyje ténylegesen érvényesül.
4. A LÉPÉSEK nem csak az első elemen állnak; strukturált állapotot kapnak.
5. A LIVE answer/reasoning/code streaming nem csak a turn végén jelenik meg.
6. Cancel megtartja a részleges munkát és `MEGSZAKÍTVA` állapotot ad.
7. Session restart után helyesen folytatható, providerkeveredés nélkül.
8. Kimi Code és Open Platform kulcs felcserélése érthető hibát ad.
9. DeepSeek tool loop nem fut 400-ba a reasoning history elvesztése miatt.
10. Nincs Min-oldali turn/stage timeout; a távoli provider limitje külön és
    pontosan jelenik meg.
11. A meglévő Codex és Claude út regresszió nélkül működik.

## Bizonytalansági és kockázati napló

| Bizonytalanság | Hatás | Kezelés |
| --- | --- | --- |
| A Kimi K3 és az új membership rendszer nagyon friss, a csomagok változhatnak | Beégetett ár/jogosultság gyorsan elavul | Dátumozott tájékoztatás, capability probe, link a hivatalos oldalra |
| Egyes Kimi help-oldalak eltérően írják le a kreditpoolt és támogatott klienseket | Kimi Code Min-integráció feltételes | Valós Min User-Agent, experimental gate, szükség esetén support-visszaigazolás |
| A Kimi Code és Open Platform azonos modellhez eltérő ID-t használ | 401/404 vagy rossz route | Access profile-hoz kötött modell ID, nincs kézi keverés |
| Claude Agent SDK kompatibilis endpointtal nem feltétlen ugyanaz, mint Claude Code CLI | Tool/session/steering eltérés | Fázis 0 teljes capability probe; sikertelenségnél natív adapter |
| Kimi web search dokumentáció önellentmondó | Instabil extra tool | Első kiadásból kihagyni |
| DeepSeek csak High/Max natív effortot ad | Félrevezető ötfokozatú slider | Provider-specifikus `Off/High/Max` |
| DeepSeek Anthropic route nem támogat képet | Attachment hiba | Capability false; élő probe nélkül tiltani |
| Direkt Chat Completions nem ad valódi mid-generation steeringet | Futás közbeni chat eltér | Capability alapú `loopBoundary` jelzés |
| Provider árak és rate limitek változhatnak | Pontatlan költségkijelzés | API usage az igazság; ármeta dátumozott/frissíthető |
| A `deepseek-v4-flash` rolling ID mögötti verzió változhat | Reprodukálhatóság | Request metadata és provider request ID mentése; verziót csak ha API visszaadja |
| K3 1M és DeepSeek 1M kontextus nem jelenti, hogy mindig célszerű mindet elküldeni | Nagy költség/latency | Compaction, tokenbecslés, Kimihez 256K opció |
| Nyílt súly nem egyenlő helyben könnyen futtatható modellel | Téves local-runtime elvárás | Self-host külön projekt; 2,8T K3 és 284B Flash nincs a desktop MVP scope-jában |

## Amit nem szabad az implementációban megtenni

- Kimit vagy DeepSeeket Claude modellként elnevezni.
- A Kimi/DeepSeek kulcsot a Claude credential slotba menteni.
- Kimi Code kulcsot az Open Platform endpointnak küldeni vagy fordítva.
- A Min User-Agentet Claude Code-ra/Codexre hamisítani.
- A DeepSeek deprecated aliasait használni.
- A kompatibilitási mapping miatt öt külön DeepSeek effortot mutatni.
- Provider-specifikus prompttal helyettesíteni a helyi toolpolicyt.
- Automatikusan retry-olni egy már végrehajtott side-effectes tool callt.
- Provideroldali remote timeoutot Min-timeoutként vagy „nincs timeout” ígéretként
  elrejteni.
- API-kulcsot localStorage-ban, SQLite-ban, syncben vagy PLAN fájlban tárolni.

## Javasolt végső sorrend

1. Provider/protokoll/runtime refaktor.
2. Élő compatibility spike külön tesztprogrammal.
3. DeepSeek V4 Flash MVP a bizonyított rövidebb runtime-úton.
4. Kimi Code K3/K3-256K experimental előfizetéses út.
5. Közös natív OpenAI Chat Completions agent runtime.
6. Kimi Open Platform raw K3.
7. DeepSeek átállítása ugyanarra a natív runtime-ra, ha az stabilabb a
   kompatibilitási bridge-nél.
8. Teljes hárommódos és TERV/KÓD/REVIEW regressziós kapu.

Ez a sorrend gyorsan ad használható eredményt, miközben nem építi bele tartósan
a téves „minden Anthropic-kompatibilis modell Claude” feltételezést.

## Elsődleges hivatalos források

### Kimi

- [Kimi API áttekintés](https://www.kimi.com/help/kimi-api/api-overview)
- [Kimi API modellválasztás](https://www.kimi.com/help/kimi-api/api-model-selection)
- [Kimi API árképzés](https://www.kimi.com/help/kimi-api/api-pricing)
- [Kimi API balance és spending limit](https://www.kimi.com/help/kimi-api/api-balance-and-usage)
- [Kimi API rate limitek](https://www.kimi.com/help/kimi-api/api-rate-limits)
- [Kimi API hibaelhárítás és termékszétválasztás](https://www.kimi.com/help/kimi-api/api-troubleshooting)
- [Kimi membership árak](https://www.kimi.com/help/membership/membership-pricing)
- [Kimi Code membership guide](https://www.kimi.com/help/kimi-code/membership-guide)
- [Kimi Code endpointok és modellazonosítók](https://www.kimi.com/code/docs/en/)
- [Kimi Code modellek és effort mapping](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [Kimi Code Claude Code út](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html)
- [Kimi CLI parancsok és ACP/server lehetőség](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)

### DeepSeek

- [DeepSeek modellek és árak](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek V4 bejelentés](https://api-docs.deepseek.com/news/news260424/)
- [DeepSeek modelllista](https://api-docs.deepseek.com/api/list-models)
- [DeepSeek Chat Completions séma](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek thinking mode és tool loop](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Anthropic-formátumú API](https://api-docs.deepseek.com/guides/anthropic_api)
- [DeepSeek Claude Code kompatibilitás](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)
- [DeepSeek rate limit és keep-alive](https://api-docs.deepseek.com/quick_start/rate_limit)
- [DeepSeek billing FAQ](https://api-docs.deepseek.com/faq)

## Implementációs állapot — 2026-08-02

### Elkészült

- A provider, runtime és access profile külön fogalom lett; Kimi és DeepSeek a
  kompatibilis protokoll ellenére sem jelenik meg Claude-ként.
- Külön credential profil és Windows Credential Manager rekord készült a Kimi
  Open Platform, Kimi Code és DeepSeek API számára.
- A modellválasztóban megjelent a Kimi K3 raw, Kimi Code K3, Kimi Code K3 256K
  és DeepSeek V4 Flash, provider-specifikus effort opciókkal.
- A modellek a nem részletes, a részletes EGY-AI és a részletes MULTI-AI
  TERV/KÓD/REVIEW útvonalon is választhatók.
- Elkészült a Kimi OpenAI Chat Completions ↔ Anthropic Messages loopback
  adapter, beleértve a streamet, tool callokat, tool resultokat, reasoning
  tartalmat és képes inputot.
- A Kimi Open Platform valódi kulcsa csak a helyi adapter upstream kérésébe
  kerül; a Claude Agent SDK gyermekfolyam nem kapja meg.
- Kimi Code és DeepSeek a dokumentált Anthropic-kompatibilis útvonalon kapott
  runtime-profilt, külön modell- és hitelesítés-ellenőrzéssel.
- A session kulcsok provider/runtime/profile szerint szét vannak választva, így
  a Kimi Code és Kimi Open Platform sessionök sem keveredhetnek.
- A Settingsben külön Mentés, Teszt és Törlés vezérlő van mindhárom új
  credential profilhoz. A kapcsolat-teszt kizárólag kézi művelet.
- Kép küldése csak a bizonyított útvonalakon engedélyezett: Kimi raw igen, Kimi
  Code és DeepSeek egyelőre nem.

### Ellenőrizve

- Agent bridge egységtesztek: 47/47 sikeres.
- Frontend/timeline egységtesztek: 112/112 sikeres.
- Rust tesztek: 193/193 sikeres.
- TypeScript és Vite production compile: sikeres; release csomag nem készült.
- GUI smoke teszt: mind a négy providerfül, mindhárom Kimi modell, a DeepSeek
  V4 Flash választás, az effort és a képcsatolás capability-tiltása helyesen
  jelent meg.

### Külső credentialt igénylő nyitott kapuk

Az implementáció kulcs nélkül teljes és lokálisan tesztelt, de az alábbiak csak
valódi szolgáltatói hozzáféréssel bizonyíthatók. Ezek nem automatikus és nem
fizetős tesztként lefuttatott állítások:

- a Kimi Open Platform aktuális `kimi-k3` modellazonosítója és az éles streaming
  válasz minden mezővariánsa;
- a Kimi Code membership kulcs tényleges jogosultsága, sessionfolytatása és tool
  loopja Min User-Agenttel;
- a DeepSeek `deepseek-v4-flash` rolling modellazonosító elérhetősége, valamint
  a `reasoning_content` visszaküldési szabálya többkörös tool használatnál;
- szolgáltatói rate limit, számlázási és account-tier viselkedés;
- Kimi Code képes input. Ez addig szándékosan tiltott marad, amíg élő probe nem
  bizonyítja.

A Settings „Teszt” gombja később kifejezett felhasználói kattintásra kis valódi
kérést indíthat, ezért minimális szolgáltatói költsége lehet. A Min nem vásárol
kreditet, nem tölt fel egyenleget és nem indít automatikus fizetős probe-ot.
