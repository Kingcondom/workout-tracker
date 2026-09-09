# Workout Tracker

เว็บบันทึกการออกกำลังกายแบบ static (ไม่มี backend) ดึงข้อมูลจาก Google Sheet แบบ realtime polling ผ่าน Google Visualization API (gviz)

## วิธีเปิดใช้งาน

เปิด `index.html` ตรงๆ ในเบราว์เซอร์ได้เลย หรือรันเซิร์ฟเวอร์เล็กๆ:

```bash
cd /Users/nut/Downloads/Workout
python3 -m http.server 8792
```

แล้วเข้า `http://localhost:8792`

## การเชื่อมต่อ Google Sheet

ตั้งค่าใน [app.js](app.js) (ตัวแปร `CONFIG` ด้านบนสุด):

- `SHEET_ID` — เอามาจาก URL ของ Sheet
- `GID` — ใส่เลข gid ถ้าต้องการดึงจากแท็บอื่น (ค่าเริ่มต้น `null` = แท็บแรก)
- `POLL_MS` — ความถี่ในการดึงข้อมูลใหม่ (ปัจจุบัน 15 วินาที)

ดึงข้อมูลด้วยเทคนิค script-tag JSONP (ไม่ใช่ `fetch`) เพื่อเลี่ยงปัญหา CORS ของ Google Sheets ทั้งหมด — ใช้ได้ทั้งรันผ่านเซิร์ฟเวอร์และเปิดไฟล์ตรงๆ

**Sheet ต้องเปิดแชร์แบบ "Anyone with the link can view" (หรือ Publish to web) ไว้เสมอ** ไม่งั้นเว็บจะดึงข้อมูลไม่ได้

## การจับคู่คอลัมน์ (ไม่ผูกกับตำแหน่งคอลัมน์)

โค้ดหาคอลัมน์จาก**ข้อความหัวตาราง** ไม่ใช่ตำแหน่ง A/B/C เพื่อให้ทนต่อการแก้ไข Sheet ในอนาคต:

| ข้อมูล | เงื่อนไขการหา |
|---|---|
| วันที่ | คอลัมน์ที่มี type เป็น `date` |
| น้ำหนัก | หัวคอลัมน์มีคำว่า "น้ำหนัก" |
| ออกกำลังกาย | หัวคอลัมน์มีคำว่า "ออกกำลังกาย" |
| Step | หัวคอลัมน์มีคำว่า "step" หรือ "ก้าว" |
| แคลอรี่รับเข้า | หัวคอลัมน์มีคำว่า "แคลอรี่" แต่ไม่มีคำว่า "เผาผลาญ"/"active" (กันสับสนกับคอลัมน์แคลอรี่ที่เผาผลาญไป) |
| โปรตีน / คาร์บ / ไขมัน | หัวคอลัมน์มีคำว่า "โปรตีน"/"protein", "คาร์บ"/"carb", "ไขมัน"/"fat" ตามลำดับ |

ถ้า Sheet ไม่มีคอลัมน์ใดคอลัมน์หนึ่งข้างต้น การ์ดที่เกี่ยวข้องบนหน้า Home จะขึ้นข้อความแจ้งเตือนแทนกราฟ/ตัวเลข เมื่อไหร่ที่เพิ่มคอลัมน์ที่มีคำตรงเงื่อนไขในหัวตาราง ระบบจะเริ่มแสดงข้อมูลให้อัตโนมัติโดยไม่ต้องแก้โค้ด

เนื่องจากแต่ละวันมีได้หลายแถว (1 แถวต่อบันทึก/มื้อ) ตรรกะที่ใช้คือ:
- **น้ำหนักของวันนั้น** = ค่าแรกที่ไม่ใช่ 0/ว่างของวันนั้น
- **แคลอรี่/โปรตีน/คาร์บ/ไขมันของวันนั้น** = ผลรวมของทุกแถวในวันนั้น

## การ์ด "โภชนาการวันนี้"

แสดงแคลอรี่/โปรตีน/คาร์บ/ไขมันของวันล่าสุดที่มีข้อมูล เทียบกับเป้าหมายของ**ช่วง (phase) ที่วันนั้นตกอยู่** แล้วบอกว่าเหลือ/เกินเท่าไหร่ พร้อมชื่อ phase กำกับ

เป้าหมายมาจากแผน periodization 18 สัปดาห์ที่กำหนดไว้ที่ `CONFIG.NUTRITION_PHASES` ใน [app.js](app.js) — แต่ละ phase มีวันเริ่ม/สิ้นสุด (inclusive) กับตัวเลข kcal/โปรตีน/คาร์บ/ไขมันของตัวเอง:

```js
NUTRITION_PHASES: [
  { name: 'Phase 0 – TDEE Reset', start: '2026-09-07', end: '2026-09-27', calories: 2650, protein: 180, carb: 320, fat: 70 },
  { name: 'Phase 1 – Controlled Cut', start: '2026-09-28', end: '2026-11-08', calories: 2150, protein: 190, carb: 200, fat: 65 },
  { name: 'Diet Break 1', start: '2026-11-09', end: '2026-11-15', calories: 2500, protein: 180, carb: 290, fat: 65 },
  { name: 'Phase 2 – Deep Cut', start: '2026-11-16', end: '2026-12-27', calories: 1975, protein: 190, carb: 160, fat: 60 },
  { name: 'Diet Break 2', start: '2026-12-28', end: '2027-01-03', calories: 2400, protein: 180, carb: 270, fat: 65 },
  { name: 'Phase 3 – Final Push', start: '2027-01-04', end: '2027-01-31', calories: 1900, protein: 190, carb: 150, fat: 60 },
],
```

Phase 2 ในตารางต้นฉบับระบุเป็นช่วง 1,950–2,000 kcal ในโค้ดใช้ค่ากึ่งกลาง 1,975 — ปรับตรงนี้ได้ถ้าต้องการค่าที่แม่นกว่า วันที่อยู่นอกทุกช่วง (ก่อน Phase 0 หรือหลัง Phase 3) จะใช้เป้าหมายของ phase ที่ใกล้ที่สุด (แรกสุด/ท้ายสุด) แทนการไม่มีเป้าหมายเลย

## วันออกกำลังกาย: Sheet เป็นค่าเริ่มต้น, Google Calendar แทนที่เมื่อมีข้อมูล

โค้ดจะ**ใช้ข้อมูลจากคอลัมน์ "ออกกำลังกาย" ใน Sheet เป็นค่าเริ่มต้นเสมอ** และจะสลับไปใช้ Google Calendar แทนโดยอัตโนมัติก็ต่อเมื่อ [workout-days.json](workout-days.json) มีข้อมูลอย่างน้อย 1 วันแล้วเท่านั้น (ดูหัวข้อถัดไปสำหรับวิธีตั้งค่า) — ก่อนตั้งค่า Calendar เสร็จ เว็บจะยังใช้ Sheet ไปพลางๆ ไม่ขึ้นเป็นค่าว่าง

## ตั้งค่า Google Calendar sync

ระบบดึงเฉพาะ event ที่ชื่อมีคำว่า **Upper / Push / Pull / Leg** (ไม่สนตัวพิมพ์เล็ก-ใหญ่) จาก Google Calendar สาธารณะ มาเป็นแหล่งข้อมูล "วันออกกำลังกาย" แทน Sheet โดยอัตโนมัติทันทีที่มีข้อมูล (ดูหัวข้อก่อนหน้า)

**สำคัญ (ความเป็นส่วนตัว):** วิธีนี้ต้องเปิด Google Calendar ทั้งอันเป็น **public** เพื่อให้ดึงผ่าน ICS feed ได้แบบไม่ต้องมี backend/API key — การเปิด public หมายความว่า **event ทั้งหมดในปฏิทิน (ไม่ใช่แค่ที่มีคำ Upper/Push/Pull/Leg) จะเข้าถึงได้โดยใครก็ตามที่มีลิงก์ ICS** แม้เว็บนี้จะกรองมาแสดงแค่วันออกกำลังกายก็ตาม **แนะนำอย่างยิ่งให้สร้าง Google Calendar แยกต่างหากสำหรับออกกำลังกายโดยเฉพาะ แล้วเปิด public เฉพาะอันนั้น** แทนปฏิทินส่วนตัวหลัก จะปลอดภัยกว่ามาก

### วิธีตั้งค่า

1. **เปิดปฏิทินเป็น public**: Google Calendar → ⚙️ Settings → เลือกปฏิทินที่ต้องการ (แนะนำให้สร้างปฏิทินใหม่แยกไว้) → "Access permissions" → ติ๊ก "Make available to public"
2. หาลิงก์ ICS: ในหน้าตั้งค่าเดียวกัน เลื่อนไปหา "Integrate calendar" → คัดลอก **"Public address in iCal format"** (จะมีรูปแบบ `https://calendar.google.com/calendar/ical/.../public/basic.ics`)
3. เก็บลิงก์นี้เป็น **GitHub Actions secret** ชื่อ `CALENDAR_ICS_URL` (repo → Settings → Secrets and variables → Actions → New repository secret) — ไม่เก็บเป็นข้อความในโค้ด เพื่อไม่ให้อีเมล/ลิงก์หลุดไปอยู่ในไฟล์ที่ public
4. รัน workflow ครั้งแรกด้วยมือ: repo → Actions → "Sync workout days from Google Calendar" → "Run workflow" (ไม่ต้องรอ cron รอบแรก ~3 วัน)
5. เมื่อรันสำเร็จ ไฟล์ [workout-days.json](workout-days.json) ในโปรเจกต์จะถูกอัปเดตและ commit กลับเข้า repo อัตโนมัติ หน้าเว็บจะดึงไฟล์นี้ (same-origin, ไม่มีปัญหา CORS) ทุกครั้งที่โหลด/รีเฟรช

หลังจากนั้นระบบจะรันอัตโนมัติทุก ~3 วันตาม cron ใน [.github/workflows/sync-calendar.yml](.github/workflows/sync-calendar.yml) (`0 3 */3 * *` — รันวันที่ 1,4,7,...ของเดือน เวลา 03:00 UTC ซึ่งใกล้เคียง "ทุก 3 วัน" แต่จะคลาดเคลื่อนเล็กน้อยตอนข้ามเดือน)

การขยาย event ที่เกิดซ้ำ (recurring, RRULE) ใช้ `python-dateutil` คำนวณย้อนหลังไม่เกิน 3 ปี และล่วงหน้าไม่เกิน 30 วันจากวันที่รัน (ปรับได้ที่ตัวแปร `MAX_HISTORY_YEARS`/`LOOKAHEAD_DAYS` ใน [scripts/sync_calendar.py](scripts/sync_calendar.py))

ถ้ายังไม่ได้ตั้งค่า หรือ `workout-days.json` ยังว่างอยู่ (`"days": []`) หน้าเว็บจะแสดงว่าไม่มีวันออกกำลังกายเลย — เป็นพฤติกรรมที่ตั้งใจ (ไม่ fallback กลับไปใช้ Sheet)

## หน้า Body Photo

ยังไม่มีคอลัมน์เก็บรูปใน Sheet และเว็บนี้ไม่มี backend จึงเก็บรูปไว้ใน **IndexedDB ของเบราว์เซอร์เครื่องนี้เท่านั้น** — ไม่ซิงก์ข้ามอุปกรณ์/เบราว์เซอร์ และไม่ถูกเขียนกลับไปที่ Google Sheet ถ้าต้องการเก็บรูปถาวรข้ามเครื่อง จะต้องเพิ่ม backend หรือ storage service ภายหลัง

## Deploy ขึ้น GitHub Pages (ใช้งานบนมือถือได้จากทุกที่)

เครื่องมือของผมไม่มี `gh` CLI ติดตั้งและไม่มีสิทธิ์เข้าบัญชี GitHub ของคุณ ขั้นตอนนี้ต้องรันเองจาก Terminal:

```bash
cd /Users/nut/Downloads/Workout
git init
git add .
git commit -m "Initial commit: workout tracker"
```

จากนั้นสร้าง repo ใหม่บน https://github.com/new (ตั้งเป็น **Public** — GitHub Pages ฟรีต้องใช้ public repo) แล้ว:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

เปิดใช้ Pages: repo → Settings → Pages → Source เลือก "Deploy from a branch" → Branch เลือก `main` / `root` → Save จะได้ลิงก์ถาวรรูปแบบ `https://<your-username>.github.io/<repo-name>/` เปิดลิงก์นี้บนมือถือได้เลย (responsive อยู่แล้ว)

อย่าลืมตั้งค่า secret `CALENDAR_ICS_URL` ตามหัวข้อด้านบนหลัง push ขึ้น repo แล้ว ไม่งั้น workflow sync calendar จะรันไม่ผ่าน

**ข้อควรรู้ก่อน deploy แบบ public:** โค้ดหน้าเว็บ (`app.js`) ฝัง Sheet ID ไว้ตรงๆ เพราะดึงข้อมูลฝั่ง browser ล้วน หมายความว่า **ใครก็ตามที่มีลิงก์เว็บนี้จะเห็นข้อมูลน้ำหนัก/แคลอรี่/วันออกกำลังกายจริงของคุณได้** เว็บนี้ไม่มีระบบ login ถ้าต้องการความเป็นส่วนตัวจริงจัง ทางเลือกคือ repo แบบ private (ต้องใช้ GitHub Pro ถึงจะเปิด Pages ได้) หรือเพิ่มระบบยืนยันตัวตน ซึ่งจะต้องมี backend เพิ่ม

### รันบนมือถือแบบทดสอบก่อน deploy จริง (ทางเลือก)

ถ้าอยากลองบนมือถือทันทีโดยยังไม่ deploy เข้าถึงผ่าน Wi-Fi บ้านเดียวกันได้:

```bash
cd /Users/nut/Downloads/Workout
python3 -m http.server 8792 --bind 0.0.0.0
```

หา IP ของเครื่อง Mac (System Settings → Wi-Fi → Details, หรือ `ipconfig getifaddr en0`) แล้วเปิดบนมือถือที่ `http://<mac-ip>:8792` (ต้องต่อ Wi-Fi เดียวกัน และเปิดเครื่อง+เซิร์ฟเวอร์นี้ค้างไว้)

## ไฟล์ในโปรเจกต์

- `index.html` — โครงหน้าเว็บทั้ง 3 หน้า (SPA, สลับหน้าด้วย JS ไม่รีโหลด)
- `style.css` — ธีมกระดานไม้/กระดาษ
- `app.js` — ดึง/แปลงข้อมูลจาก Sheet, กราฟน้ำหนัก+Step, ปฏิทิน, รวมข้อมูลวันออกกำลังกายจาก Calendar
- `photos.js` — จัดการรูปภาพผ่าน IndexedDB
- `workout-days.json` — ผลลัพธ์วันออกกำลังกายจาก Calendar (อัปเดตอัตโนมัติโดย GitHub Actions)
- `scripts/sync_calendar.py` — ดึง ICS feed, กรอง event, ขยาย recurring event, เขียน `workout-days.json`
- `.github/workflows/sync-calendar.yml` — cron รันสคริปต์ด้านบนทุก ~3 วัน
