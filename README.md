# 4 UHA Render MCP

Konektor za Claude koji radi rendere preko **OpenAI (gpt-image-2)** i **xAI Grok Imagine (grok-imagine-image-2.0)**.
Radi na Cloudflare Workers, a podloge i gotove rendere sprema u R2 bucket `4uha-renders`.

## Alati koje Claude dobiva

| Alat | Što radi |
|---|---|
| `render_image` | render iz teksta ili iz podloge (screenshot iz ArchiCAD-a, skica); `provider`: `openai`, `xai` ili `both` |
| `list_uploads` | popis uploadanih podloga s ID-evima i link na stranicu za upload |
| `upload_image` | sprema sliku poslanu iz Claudea (base64) — za maske koje Claude izradi |

## Vjernost geometriji (v1.1)

- `aspect: "wide"` (2048×1152, 16:9) — omjer izlaza mora biti jednak podlozi, inače model re-komponira kadar.
- `input_fidelity: "high"` (zadano uz podlogu) — najveća vjernost podlozi.
- `mask_id` — PNG maska iste veličine kao podloga: prozirno = smije se mijenjati, neprozirno = zaključano.
- Uz podlogu ne slati dodatne slike (npr. Google Maps) — okolina se opisuje tekstom.
- Ako API neki parametar ne prihvati, konektor pokuša blaže i to **izričito napiše** uz rezultat.
- Kontrola geometrije prema podlozi i dalje je obavezna prije predaje.

## Postavljanje (jednom)

1. **Cloudflare → R2 → Create bucket**: naziv `4uha-renders`.
2. **Workers & Pages → Create → Import a repository**: odaberi ovaj repo. Worker se mora zvati `4uha-render-mcp`. Deploy.
3. **Worker → Settings → Variables and Secrets** → dodaj kao *Secret*:
   - `OPENAI_API_KEY`: ključ s platform.openai.com
   - `XAI_API_KEY`: ključ s console.x.ai (opcionalno; bez njega radi samo OpenAI)
   - `ACCESS_TOKEN`: dugi nasumični niz (lozinka konektora)
4. **Claude → postavke konektora → Add custom connector**
   - Naziv: `4UHA Render`
   - URL: `https://4uha-render-mcp.<racun>.workers.dev/mcp/<ACCESS_TOKEN>`

## Korištenje

1. Otvori `https://4uha-render-mcp.<racun>.workers.dev/upload/<ACCESS_TOKEN>` (spremi u bookmark) i uploadaj screenshot.
2. U Claudeu napiši npr.: *„render iz zadnjeg uploada, A26-009, kasno poslijepodne, oba modela”*.
3. Claude napiše prompt, pozove oba servisa, provjeri geometriju prema podlozi i vrati linkove za preuzimanje.

## Napomene

- Modeli se mijenjaju u `wrangler.toml` (`OPENAI_IMAGE_MODEL`, `XAI_IMAGE_MODEL`), bez izmjene koda.
- Grok koristi samo prvu referentnu sliku, a OpenAI više njih.
- Linkovi `/f/...` su nasumični i nepogodivi, ali svatko tko ima link može otvoriti sliku. Ne dijeliti javno.
- Ključevi se **nikad** ne upisuju u repo, samo u Cloudflare Secrets.
- Troškovi: plaća se po slici kod OpenAI-ja i xAI-ja; Cloudflare Workers i R2 su za ovakvu upotrebu besplatni.
