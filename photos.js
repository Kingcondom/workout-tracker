// ===== Body Photo page: local-only storage via IndexedDB =====
// No backend exists, so photos are saved in this browser only (not synced
// across devices, not written back to the Google Sheet).

const PHOTO_DB_NAME = 'workout-photos-db';
const PHOTO_STORE = 'photos';
const MAX_PHOTO_WIDTH = 1280;

function openPhotoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        const store = db.createObjectStore(PHOTO_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('dateKey', 'dateKey');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addPhotoRecord(record) {
  const db = await openPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllPhotos() {
  const db = await openPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const req = tx.objectStore(PHOTO_STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || '')));
    req.onerror = () => reject(req.error);
  });
}

async function deletePhotoRecord(id) {
  const db = await openPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, MAX_PHOTO_WIDTH / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFilesSelected(fileList, dateKeyStr) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  for (const file of files) {
    const dataUrl = await resizeImageFile(file);
    await addPhotoRecord({ dateKey: dateKeyStr, dataUrl, createdAt: Date.now() });
  }
  await renderPhotoGallery();
}

function formatThaiDate(dateKeyStr) {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function renderPhotoGallery() {
  const gallery = document.getElementById('photo-gallery');
  const photos = await getAllPhotos();
  if (photos.length === 0) {
    gallery.innerHTML = '<div class="empty-gallery">ยังไม่มีรูปที่บันทึกไว้</div>';
    return;
  }
  gallery.innerHTML = '';
  photos.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'photo-item';
    item.innerHTML = `
      <img src="${p.dataUrl}" alt="body photo ${p.dateKey}">
      <div class="photo-date">${formatThaiDate(p.dateKey)}</div>
      <button class="del-btn" title="ลบรูป">✕</button>
      <div class="del-confirm" hidden>
        <span>ลบรูปนี้?</span>
        <button class="del-yes">ลบ</button>
        <button class="del-no">ยกเลิก</button>
      </div>
    `;
    item.querySelector('img').addEventListener('click', () => openLightbox(p.dataUrl));

    const delBtn = item.querySelector('.del-btn');
    const confirmBox = item.querySelector('.del-confirm');

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delBtn.hidden = true;
      confirmBox.hidden = false;
    });
    confirmBox.querySelector('.del-no').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmBox.hidden = true;
      delBtn.hidden = false;
    });
    confirmBox.querySelector('.del-yes').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePhotoRecord(p.id);
      renderPhotoGallery();
    });
    gallery.appendChild(item);
  });
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${src}">`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function initPhotoPage() {
  const dateInput = document.getElementById('photo-date');
  dateInput.value = dateKey(new Date());

  document.getElementById('photo-input').addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    await handleFilesSelected(e.target.files, dateInput.value);
    e.target.value = '';
  });

  renderPhotoGallery();
}
