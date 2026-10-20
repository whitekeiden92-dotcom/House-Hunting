import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Listing = {
  id: number;
  kind: string;
  type: string;
  area: string;
  address: string;
  price: number;
  beds: number;
  baths: number;
  sqft: number;
  description?: string;
  status?: string;
  cover?: string | null;
  photos?: string[];
  verified?: boolean;
  checks?: { photos: number; address: number; price: number; owner: number; note: string; reviewed_by: string | null; reviewed_at: string | null } | null;
  documents?: { id: number; original_name: string }[];
  lat?: number | null;
  lng?: number | null;
  owner_id?: number;
  owner_rating?: number | null;
  owner_reviews?: number;
  photo_items?: { id: number; url: string }[];
};
type Me = { id: number; name: string | null; email: string | null; role: string } | null;
type InboxMessage = { id: number; name: string; email: string; message: string; created_at: string; read_at: string | null; listing_id: number; address: string };

const KIND: Record<string, string> = { sale: 'For sale', rent: 'For rent', stay: 'Short stay' };
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const money = (l: Listing): string =>
  'KSh ' + l.price.toLocaleString('en-US') + (l.kind === 'rent' ? ' a month' : l.kind === 'stay' ? ' a night' : '');
const specs = (l: Listing): string =>
  `${l.beds} ${l.beds === 1 ? 'bed' : 'beds'} · ${l.baths} ${l.baths === 1 ? 'bath' : 'baths'} · ${l.sqft.toLocaleString('en-US')} sq ft`;

const view = document.getElementById('view') as HTMLElement;
const nav = document.getElementById('nav') as HTMLElement;
let me: Me = null;
let currentMap: L.Map | null = null;
let pendingFilters = new URLSearchParams();

function resetMap(): void {
  currentMap?.remove();
  currentMap = null;
}

function toast(message: string, tone: 'ok' | 'warn' = 'ok'): void {
  const box = document.getElementById('toasts') as HTMLElement;
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add('leave'), 3600);
  setTimeout(() => el.remove(), 4000);
}

const skeleton = (): string =>
  `<section class="head"><div class="skel title"></div><div class="skel line"></div></section>
   <div class="grid">${'<div class="skel card"></div>'.repeat(4)}</div>`;

const pinLabel = (l: Listing): string => {
  const p = l.price;
  const short = (n: number, unit: string): string => `KSh ${n.toFixed(1).replace('.0', '')}${unit}`;
  if (p >= 1e6) return short(p / 1e6, 'M');
  if (p >= 1000) return short(p / 1000, 'K');
  return `KSh ${p}`;
};

const addTiles = (map: L.Map): void => {
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
};

const pinIcon = (l: Listing): L.DivIcon =>
  L.divIcon({ className: 'price-pin', html: `<span>${esc(pinLabel(l))}</span>`, iconSize: [64, 30], iconAnchor: [32, 15] });


async function api<T>(path: string, options: { method?: string; json?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? 'GET', credentials: 'same-origin' };
  if (options.json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data as T;
}

function renderNav(): void {
  const review = me?.role === 'admin'
    ? '<a href="#/admin"><span class="ico" aria-hidden="true">🛠️</span><span class="lbl">Review</span></a>'
    : '';
  nav.innerHTML = '<a href="#/listings"><span class="ico" aria-hidden="true">🏡</span><span class="lbl">Browse</span></a>'
    + '<a href="#/add"><span class="ico" aria-hidden="true">➕</span><span class="lbl long">List a home</span><span class="lbl short">List</span></a>'
    + '<a href="#/saved"><span class="ico" aria-hidden="true">♡</span><span class="lbl">Saved</span></a>'
    + '<a href="#/mine"><span class="ico" aria-hidden="true">🗂️</span><span class="lbl long">My homes</span><span class="lbl short">Mine</span></a>'
    + review
    + (me
      ? `<span class="who">${esc(me.name || me.email || 'Signed in')}</span><button class="pill" id="logout" type="button"><span class="ico" aria-hidden="true">⎋</span><span class="lbl">Sign out</span></button>`
      : '<a class="pill" href="#/signin"><span class="ico" aria-hidden="true">👤</span><span class="lbl">Sign in</span></a>');
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => undefined);
    me = null;
    renderNav();
    location.hash = '#/listings';
    route().catch(() => undefined);
  });
}

function signInPrompt(text: string): string {
  return `<section class="head"><h1>Sign in</h1><p class="lede">${esc(text)}</p></section>
    <div class="signin">
      <a class="provider" href="/auth/google">Continue with Google</a>
    </div>
    <p class="meta">We use your name and email only to run your account.</p>`;
}

function card(l: Listing): string {
  const photo = l.cover
    ? `<div class="ph" style="background-image:url('${esc(l.cover)}')"></div>`
    : '<div class="ph"><span>Photos coming soon</span></div>';
  const trustedHost = (l.owner_reviews ?? 0) >= 5 && (l.owner_rating ?? 0) >= 4.5;
  const host = l.owner_reviews
    ? `<p class="host-stars" aria-label="Owner rating">★ ${esc(l.owner_rating)} <span>(${esc(l.owner_reviews)})</span>${trustedHost ? ' · <span class="trusted">Trusted host</span>' : ''}</p>`
    : '';
  return `<a class="card" href="#/listing/${l.id}">${photo}
    <div class="body">
      <span class="tag">${esc(KIND[l.kind] ?? l.kind)}</span>${l.verified ? ' <span class="tag verified">Verified</span>' : ''}
      <p class="price">${esc(money(l))}</p>
      <h3>${esc(l.address)}</h3>
      <p class="meta">${esc(l.area)} · ${esc(l.type)}</p>
      ${host}
      <p class="specs">${esc(specs(l))}</p>
    </div></a>`;
}

async function listingsPage(): Promise<void> {
  view.innerHTML = `<section class="head"><h1>Find a home</h1>
      <p class="lede">Homes for sale, for rent and for short stays. Every listing is checked by our team before it goes live.</p></section>
    <div class="chips" role="group" aria-label="Quick filters">
      <button type="button" class="chip" data-kind="">All</button>
      <button type="button" class="chip" data-kind="sale">For sale</button>
      <button type="button" class="chip" data-kind="rent">For rent</button>
      <button type="button" class="chip" data-kind="stay">Short stay</button>
    </div>
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Area or street" aria-label="Area or street" />
      <select name="kind" aria-label="Listing type"><option value="">Any listing</option><option value="sale">For sale</option><option value="rent">For rent</option><option value="stay">Short stay</option></select>
      <select name="type" aria-label="Property type"><option value="">Any type</option><option>House</option><option>Apartment</option><option>Townhouse</option><option>Condo</option></select>
      <select name="minBeds" aria-label="Bedrooms"><option value="">Any bedrooms</option><option value="1">1 or more</option><option value="2">2 or more</option><option value="3">3 or more</option><option value="4">4 or more</option></select>
      <input name="maxPrice" type="number" min="0" placeholder="Max price (KSh)" aria-label="Max price (KSh)" />
      <select name="sort" aria-label="Sort"><option value="price_asc">Lowest price</option><option value="price_desc">Highest price</option><option value="beds_desc">Most bedrooms</option></select>
    </form>
    <div class="bar"><p class="count" id="count"></p><button type="button" class="ghost small" id="saveSearch">Save this search</button></div>
    <div class="grid" id="grid"></div>`;

  const form = document.getElementById('filters') as HTMLFormElement;
  pendingFilters.forEach((value, key) => {
    const field = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = value;
  });
  const grid = document.getElementById('grid') as HTMLElement;
  const count = document.getElementById('count') as HTMLElement;
  const kindField = form.elements.namedItem('kind') as HTMLSelectElement;
  const chips = Array.from(view.querySelectorAll<HTMLButtonElement>('.chip'));
  const syncChips = (): void => chips.forEach((chip) => chip.classList.toggle('on', chip.dataset.kind === kindField.value));
  chips.forEach((chip) => chip.addEventListener('click', () => {
    kindField.value = chip.dataset.kind ?? '';
    form.dispatchEvent(new Event('change'));
  }));

  const load = async (): Promise<void> => {
    const params = new URLSearchParams(new FormData(form) as unknown as Record<string, string>);
    for (const [key, value] of Array.from(params.entries())) if (!value) params.delete(key);
    syncChips();
    const { listings } = await api<{ listings: Listing[] }>(`/api/listings?${params.toString()}`);
    count.textContent = listings.length ? `${listings.length} ${listings.length === 1 ? 'home' : 'homes'} to see` : '';
    grid.innerHTML = listings.length
      ? listings.map(card).join('')
      : '<div class="empty-state"><span>🔍</span><p>No homes match yet. Try wider filters, or save this search and we will email you when one appears.</p></div>';
  };
  form.addEventListener('input', () => { load().catch(() => undefined); });
  form.addEventListener('change', () => { load().catch(() => undefined); });

  document.getElementById('saveSearch')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const params = new URLSearchParams(new FormData(form) as unknown as Record<string, string>);
    const filters: Record<string, string> = {};
    params.forEach((value, key) => { if (value) filters[key] = value; });
    if (!Object.keys(filters).length) return toast('Choose a filter first, then save the search.', 'warn');
    if (!me) {
      location.hash = '#/signin';
      return toast('Sign in to save searches.', 'warn');
    }
    const name = [
      filters.kind ? KIND[filters.kind] : '',
      filters.type ?? '',
      filters.q ?? '',
      filters.minBeds ? `${filters.minBeds}+ beds` : '',
      filters.maxPrice ? `up to KSh ${Number(filters.maxPrice).toLocaleString('en-US')}` : '',
    ].filter(Boolean).join(' · ') || 'My search';
    try {
      await api('/api/searches', { method: 'POST', json: { name, filters } });
      button.classList.remove('pop');
      void button.offsetWidth;
      button.classList.add('pop');
      toast('Search saved. We will email you when a matching home is approved.');
    } catch (err) {
      toast((err as Error).message, 'warn');
    }
  });

  await load();
}

async function listingPage(id: string): Promise<void> {
  const { listing: l } = await api<{ listing: Listing & { photos: string[]; description: string } }>(
    `/api/listings/${encodeURIComponent(id)}`,
  );
  const photos = l.photos?.length
    ? l.photos.map((src) => `<img src="${esc(src)}" alt="Photo of ${esc(l.address)}" loading="lazy" />`).join('')
    : '<div class="ph"><span>No photos yet</span></div>';
  const hasPin = l.lat != null && l.lng != null;
  view.innerHTML = `<section class="detail">
      <div class="gallery">${photos}</div>
      <div class="facts">
        <span class="tag">${esc(KIND[l.kind] ?? l.kind)}</span>${l.verified ? ' <span class="tag verified">Verified by our team</span>' : ''}
        <h1>${esc(l.address)}</h1>
        <p class="price">${esc(money(l))}</p>
        <p class="meta">${esc(l.area)} · ${esc(l.type)}</p>
        <p class="specs">${esc(specs(l))}</p>
        ${hostRow(l)}
        <p class="desc">${esc(l.description ?? '')}</p>
        <div class="row">
          ${me ? '<button class="primary" id="save" type="button">Save home</button>' : '<a class="primary" href="#/signin">Sign in to save</a>'}
          <button class="ghost" id="share" type="button">Share this home</button>
        </div>
        ${hasPin ? '<div class="map small" id="miniMap" aria-label="Location on the map"></div>' : ''}
      </div>
    </section>
    <form class="inquiry" id="inquiry">
      <h2>Contact the owner</h2>
      <input name="name" required maxlength="80" placeholder="Your name" aria-label="Your name" />
      <input name="email" type="email" required maxlength="254" placeholder="Your email" aria-label="Your email" />
      <textarea name="message" required maxlength="1000" rows="4" placeholder="Your message" aria-label="Your message"></textarea>
      <button class="primary" type="submit">Send message</button>
      <p class="note" id="inqNote" hidden></p>
    </form>
    <details class="report">
      <summary>Report this listing</summary>
      <form id="reportForm">
        <select name="reason" required aria-label="Reason">
          <option value="">Choose a reason</option>
          <option value="fake">This home looks fake</option>
          <option value="scam">Asked me for money or a deposit</option>
          <option value="wrong_details">Wrong details or photos</option>
          <option value="sold_or_rented">Already sold or rented</option>
          <option value="other">Something else</option>
        </select>
        <textarea name="details" maxlength="1000" rows="3" placeholder="What did you notice? (optional)" aria-label="Details"></textarea>
        <input name="email" type="email" maxlength="254" placeholder="Your email, if you want a reply (optional)" aria-label="Your email" />
        <button class="ghost" type="submit">Send report</button>
        <p class="note" id="reportNote" hidden></p>
      </form>
    </details>`;

  document.getElementById('save')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    try {
      await api(`/api/saved/${l.id}`, { method: 'POST' });
      button.classList.add('pop');
      button.textContent = 'Saved ♥';
      button.disabled = true;
      toast('Saved to your list.');
    } catch (err) {
      toast((err as Error).message, 'warn');
    }
  });

  document.getElementById('share')?.addEventListener('click', async () => {
    const url = `${location.href.split('#')[0]}#/listing/${l.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: l.address, text: `${money(l)} · ${l.address}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('Link copied. Paste it anywhere to share this home.');
      }
    } catch {
      // The person closed the share sheet, or copying is not allowed in this browser.
    }
  });

  if (hasPin) {
    const mini = L.map('miniMap', { scrollWheelZoom: false }).setView([l.lat as number, l.lng as number], 14);
    currentMap = mini;
    addTiles(mini);
    L.marker([l.lat as number, l.lng as number], { icon: pinIcon(l) }).addTo(mini);
    setTimeout(() => mini.invalidateSize(), 0);
  }

  const inquiry = document.getElementById('inquiry') as HTMLFormElement;
  const note = document.getElementById('inqNote') as HTMLElement;
  inquiry.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(inquiry)) as Record<string, string>;
    try {
      await api(`/api/listings/${l.id}/inquiries`, { method: 'POST', json: data });
      inquiry.reset();
      note.hidden = true;
      toast('Message sent. The owner has been emailed and will reply to you.');
    } catch (err) {
      note.textContent = (err as Error).message;
      note.hidden = false;
    }
  });

  const report = document.getElementById('reportForm') as HTMLFormElement;
  const reportNote = document.getElementById('reportNote') as HTMLElement;
  report.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(report)) as Record<string, string>;
    try {
      await api(`/api/listings/${l.id}/reports`, { method: 'POST', json: data });
      report.reset();
      reportNote.hidden = true;
      toast('Thank you. The review team will look at this listing.');
    } catch (err) {
      reportNote.textContent = (err as Error).message;
      reportNote.hidden = false;
    }
  });
}

async function uploadFiles(id: number, field: 'photos' | 'documents', picked: File[]): Promise<void> {
  if (!picked.length) return;
  const fd = new FormData();
  picked.forEach((f) => fd.append(field, f));
  const res = await fetch(`/api/listings/${id}/${field}`, { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    const what = field === 'photos' ? 'photos' : 'documents';
    throw new Error(`Saved, but the ${what} were not uploaded: ${problem.error ?? 'please try again'}`);
  }
}

// One form for listing a new home and for editing one. Click the map to place the pin.
function listingForm(existing: Listing | null): void {
  if (!me) {
    view.innerHTML = signInPrompt(existing ? 'Sign in to edit your home.' : 'Sign in to list a home.');
    return;
  }
  const v = (value: unknown): string => esc(value ?? '');
  const option = (value: string, label: string, current: string | undefined): string =>
    `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
  const kinds: [string, string][] = [['sale', 'For sale'], ['rent', 'For rent'], ['stay', 'Short stay']];
  const types = ['House', 'Apartment', 'Townhouse', 'Condo'];
  const hasPin = existing?.lat != null && existing?.lng != null;
  view.innerHTML = `<section class="head"><h1>${existing ? 'Edit your home' : 'List a home'}</h1>
      <p class="lede">${existing
        ? 'Changes go back to our team for a quick check before they show again.'
        : 'Add the details, photos and any proof of ownership. Our team checks everything before your home goes live.'}</p></section>
    <form class="form" id="homeForm">
      <label>Listing type<select name="kind">${kinds.map(([val, label]) => option(val, label, existing?.kind)).join('')}</select></label>
      <label>Property type<select name="type">${types.map((t) => option(t, t, existing?.type)).join('')}</select></label>
      <label>Area<input name="area" required maxlength="80" value="${v(existing?.area)}" /></label>
      <label>Street address<input name="address" required maxlength="160" value="${v(existing?.address)}" /></label>
      <label>Price (KSh)<input name="price" type="number" min="1" required value="${v(existing?.price)}" /></label>
      <label>Bedrooms<input name="beds" type="number" min="0" max="20" required value="${v(existing?.beds)}" /></label>
      <label>Bathrooms<input name="baths" type="number" min="0" max="20" step="0.5" required value="${v(existing?.baths)}" /></label>
      <label>Size (sq ft)<input name="sqft" type="number" min="1" required value="${v(existing?.sqft)}" /></label>
      <label class="wide">Description<textarea name="description" rows="5" required maxlength="2000">${v(existing?.description)}</textarea></label>
      <div class="wide picker-block">
        <div class="picker-head"><span>Location on the map</span><button type="button" class="ghost small" id="clearPin">Clear pin</button></div>
        <div class="map picker" id="picker" aria-label="Click the map to place the pin"></div>
        <p class="meta" id="pinNote">${hasPin ? 'Pin placed. Drag it to fine-tune it.' : 'Click the map to place the pin. It helps buyers find the home.'}</p>
        <input type="hidden" name="lat" value="${v(existing?.lat)}" />
        <input type="hidden" name="lng" value="${v(existing?.lng)}" />
      </div>
      ${existing?.photo_items?.length
        ? `<div class="strip wide">${existing.photo_items.map((item) => `<div class="photo-item"><img src="${esc(item.url)}" alt="" /><button type="button" class="ghost small remove" data-remove-photo="${item.id}">Remove</button></div>`).join('')}</div>`
        : ''}
      <div class="wide filepick">
          <span class="filepick-title">${existing ? 'Add more photos' : 'Photos'} (JPEG, PNG or WebP, up to 8)</span>
          <label class="glass-btn filepick-btn"><span aria-hidden="true">📷</span>Choose photos<input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple /></label>
          <span class="filepick-status" data-status-for="photos">No photos chosen yet</span>
        </div>
        <div class="wide filepick">
          <span class="filepick-title">Proof of ownership or lease (PDF or photo, private)</span>
          <label class="glass-btn filepick-btn"><span aria-hidden="true">📄</span>Choose files<input name="documents" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple /></label>
          <span class="filepick-status" data-status-for="documents">No documents chosen yet</span>
        </div>
      
<div class="strip wide" id="previews"></div>
      <button class="primary" type="submit">${existing ? 'Save changes' : 'Submit for review'}</button>
      <p class="note wide" id="formNote" hidden></p>
    </form>`;

  const form = document.getElementById('homeForm') as HTMLFormElement;
  const latInput = form.elements.namedItem('lat') as HTMLInputElement;
  const lngInput = form.elements.namedItem('lng') as HTMLInputElement;
  const pinNote = document.getElementById('pinNote') as HTMLElement;
  const start: [number, number] = hasPin ? [existing?.lat as number, existing?.lng as number] : [20, 0];
  const picker = L.map('picker').setView(start, hasPin ? 14 : 2);
  currentMap = picker;
  addTiles(picker);
  let pin: L.Marker | null = null;
  const placePin = (lat: number, lng: number): void => {
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
    if (pin) {
      pin.setLatLng([lat, lng]);
    } else {
      pin = L.marker([lat, lng], { draggable: true }).addTo(picker);
      pin.on('dragend', () => {
        const p = (pin as L.Marker).getLatLng();
        placePin(p.lat, p.lng);
      });
    }
    pinNote.textContent = 'Pin placed. Drag it to fine-tune it.';
  };
  if (hasPin) placePin(start[0], start[1]);
  picker.on('click', (event: L.LeafletMouseEvent) => placePin(event.latlng.lat, event.latlng.lng));
  document.getElementById('clearPin')?.addEventListener('click', () => {
    latInput.value = '';
    lngInput.value = '';
    pin?.remove();
    pin = null;
    pinNote.textContent = 'Click the map to place the pin. It helps buyers find the home.';
  });

  view.querySelectorAll<HTMLButtonElement>('[data-remove-photo]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!existing) return;
      try {
        await api(`/api/listings/${existing.id}/photos/${button.dataset.removePhoto}`, { method: 'DELETE' });
        toast('Photo removed. Save changes to send your home back for review.');
        await editPage(String(existing.id));
      } catch (err) {
        toast((err as Error).message, 'warn');
      }
    });
  });
  const files = form.elements.namedItem('photos') as HTMLInputElement;
  const docFiles = form.elements.namedItem('documents') as HTMLInputElement;
  const describePicked = (input: HTMLInputElement, empty: string, one: string, many: string): void => {
    const picked = Array.from(input.files ?? []);
    const status = form.querySelector<HTMLElement>(`[data-status-for="${input.name}"]`);
    if (status) {
      status.textContent = picked.length === 0 ? empty
        : picked.length === 1 ? `1 ${one} chosen: ${picked[0].name}`
        : `${picked.length} ${many} chosen`;
    }
  };
  files.addEventListener('change', () => describePicked(files, 'No photos chosen yet', 'photo', 'photos'));
  docFiles.addEventListener('change', () => describePicked(docFiles, 'No documents chosen yet', 'document', 'documents'));

  const previews = document.getElementById('previews') as HTMLElement;
  files.addEventListener('change', () => {
    previews.innerHTML = Array.from(files.files ?? []).slice(0, 8)
      .map((f) => `<img src="${URL.createObjectURL(f)}" alt="" />`).join('');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = document.getElementById('formNote') as HTMLElement;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const body = {
      kind: data.kind, type: data.type, area: data.area, address: data.address,
      price: Number(data.price), beds: Number(data.beds), baths: Number(data.baths),
      sqft: Number(data.sqft), description: data.description,
      lat: data.lat ? Number(data.lat) : null, lng: data.lng ? Number(data.lng) : null,
    };
    note.hidden = true;
    try {
      let id = existing?.id ?? 0;
      if (existing) {
        await api(`/api/listings/${existing.id}`, { method: 'PUT', json: body });
      } else {
        id = (await api<{ id: number }>('/api/listings', { method: 'POST', json: body })).id;
      }
      await uploadFiles(id, 'photos', Array.from(files.files ?? []).slice(0, 8));
      await uploadFiles(id, 'documents', Array.from(docFiles.files ?? []).slice(0, 3));
      await api(`/api/listings/${id}/submit`, { method: 'POST' });
      if (existing) {
        toast('Changes saved. Our team will check them again.');
        location.hash = '#/mine';
      } else {
        form.reset();
        previews.innerHTML = '';
        toast('Thank you! Your home is with our team for review.');
      }
    } catch (err) {
      note.textContent = (err as Error).message;
      note.hidden = false;
    }
  });
}

async function editPage(id: string): Promise<void> {
  if (!me) {
    view.innerHTML = signInPrompt('Sign in to edit your home.');
    return;
  }
  const { listing } = await api<{ listing: Listing & { photos: string[]; description: string } }>(
    `/api/listings/${encodeURIComponent(id)}`,
  );
  listingForm(listing);
}

async function minePage(): Promise<void> {
  if (!me) {
    view.innerHTML = signInPrompt('Sign in to see your homes and messages.');
    return;
  }
  const [{ listings }, { messages, unread }] = await Promise.all([
    api<{ listings: Listing[] }>('/api/my/listings'),
    api<{ messages: InboxMessage[]; unread: number }>('/api/my/inbox'),
  ]);
  view.innerHTML = `<section class="head"><h1>My homes</h1>
      <p class="lede">${listings.length} ${listings.length === 1 ? 'home' : 'homes'} · ${unread} unread ${unread === 1 ? 'message' : 'messages'}</p></section>
    <h2 class="section-title">Messages</h2>
    <div class="list">${messages.map((m) => `
      <div class="message${m.read_at ? '' : ' unread'}">
        <div class="message-head"><strong>${esc(m.name)}</strong> <span class="meta">about ${esc(m.address)} · ${esc(m.created_at)}</span></div>
        <p class="message-body">${esc(m.message)}</p>
        <div class="row">
          <a class="ghost small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent(`Re: ${m.address}`)}">Reply by email</a>
          ${m.read_at ? '' : `<button class="ghost small" type="button" data-read="${m.id}">Mark as read</button>`}
        </div>
      </div>`).join('') || '<div class="empty-state"><span>✉️</span><p>No messages yet. When someone contacts you about a home, it appears here.</p></div>'}</div>
    <h2 class="section-title">Your listings</h2>
    <div class="list">${listings.map((l) => `
      <div class="row-item">
        ${l.cover ? `<img class="thumb" src="${esc(l.cover)}" alt="" />` : '<div class="thumb"></div>'}
        <div><p class="price">${esc(money(l))}</p><h3>${esc(l.address)}</h3><p class="meta">${esc(l.area)} · ${esc(l.type)}</p></div>
        <span class="status ${esc(l.status)}">${esc(l.status)}</span>
        <a class="ghost small" href="#/edit/${l.id}">Edit</a>
        <label class="ghost small upload">Add document
          <input type="file" data-docs="${l.id}" accept="application/pdf,image/jpeg,image/png,image/webp" multiple />
        </label>
        <button class="ghost small" type="button" data-del="${l.id}">Delete</button>
      </div>`).join('') || '<div class="empty-state"><span>🏡</span><p>You have not listed a home yet. <a href="#/add">List your first home</a>.</p></div>'}</div>`;

  view.querySelectorAll<HTMLButtonElement>('[data-read]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/my/inbox/${button.dataset.read}/read`, { method: 'POST' });
      toast('Marked as read.');
      await minePage();
    });
  });
  view.querySelectorAll<HTMLInputElement>('[data-docs]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await uploadFiles(Number(input.dataset.docs), 'documents', Array.from(input.files ?? []).slice(0, 3));
        toast('Documents uploaded. Only the review team can see them.');
        await minePage();
      } catch (err) {
        toast((err as Error).message, 'warn');
      }
    });
  });
  view.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Delete this listing and its photos and documents?')) return;
      await api(`/api/listings/${button.dataset.del}`, { method: 'DELETE' });
      toast('Listing deleted.');
      await minePage();
    });
  });
}

async function savedPage(): Promise<void> {
  if (!me) {
    view.innerHTML = signInPrompt('Sign in to see the homes and searches you saved.');
    return;
  }
  const [{ listings }, { searches }] = await Promise.all([
    api<{ listings: Listing[] }>('/api/saved'),
    api<{ searches: { id: number; name: string; filters: Record<string, string> }[] }>('/api/searches'),
  ]);
  view.innerHTML = `<section class="head"><h1>Saved</h1></section>
    <h2 class="section-title">Your searches</h2>
    <div class="searches">${searches.map((s) => `
      <div class="search-card">
        <div><strong>${esc(s.name)}</strong><p class="meta">We email you when a matching home is approved.</p></div>
        <div class="row">
          <a class="ghost small" href="#/listings?${new URLSearchParams(s.filters).toString()}">Run search</a>
          <button class="ghost small" type="button" data-delete-search="${s.id}">Delete</button>
        </div>
      </div>`).join('') || '<div class="empty-state"><span>🔎</span><p>No saved searches yet. On Find a home, choose filters and tap Save this search.</p></div>'}</div>
    <h2 class="section-title">Saved homes</h2>
    <div class="grid">${listings.map(card).join('') || '<div class="empty-state"><span>♡</span><p>Nothing saved yet. Tap Save home on any listing.</p></div>'}</div>`;

  view.querySelectorAll<HTMLButtonElement>('[data-delete-search]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/searches/${button.dataset.deleteSearch}`, { method: 'DELETE' });
      toast('Search removed.');
      await savedPage();
    });
  });
}

const starsOf = (value: number | null | undefined): string => {
  const filled = Math.round(value ?? 0);
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
};

const hostRow = (l: Listing): string => {
  if (!l.owner_id) return '';
  const rating = l.owner_reviews
    ? `<span class="stars" aria-label="${esc(l.owner_rating)} out of 5">${starsOf(l.owner_rating)}</span> ${esc(l.owner_rating)} <span class="meta">(${esc(l.owner_reviews)} reviews)</span>`
    : '<span class="meta">New owner</span>';
  return `<p class="host-row">Listed by <a href="#/owner/${l.owner_id}">view their profile</a> · ${rating}</p>`;
};

async function ownerPage(id: string): Promise<void> {
  const data = await api<{
    owner: { id: number; name: string; rating: number | null; count: number; trusted: boolean };
    listings: Listing[];
    reviews: { id: number; stars: number; comment: string; created_at: string; reviewer: string; reply: string | null; reply_at: string | null }[];
    myReview: { stars: number; comment: string } | null;
    canReview: boolean;
  }>(`/api/owners/${encodeURIComponent(id)}`);
  const o = data.owner;
  const isOwner = me?.id === o.id;
  const reviewsHtml = data.reviews.map((r) => `
    <article class="review">
      <div class="review-head">
        <span class="stars" aria-label="${r.stars} out of 5 stars">${starsOf(r.stars)}</span>
        <strong>${esc(r.reviewer)}</strong><span class="meta">${esc(r.created_at)}</span>
        ${me?.role === 'admin' ? `<button class="ghost small" type="button" data-hide="${r.id}">Hide review</button>` : ''}
      </div>
      <p class="message-body">${esc(r.comment || 'No comment left.')}</p>
      ${r.reply
        ? `<div class="reply"><strong>Reply from ${esc(o.name)}</strong> <span class="meta">${esc(r.reply_at ?? '')}</span><p class="message-body">${esc(r.reply)}</p></div>`
        : isOwner
          ? `<form class="reply-form" data-reply="${r.id}">
               <textarea name="reply" rows="2" maxlength="500" placeholder="Thank the reviewer or answer their question" aria-label="Your reply"></textarea>
               <button class="ghost small" type="submit">Post reply</button>
             </form>`
          : ''}
    </article>`).join('') || '<div class="empty-state"><span>⭐</span><p>No reviews yet. Reviews appear here after a visitor has been in touch.</p></div>';

  let reviewBox: string;
  if (!me) {
    reviewBox = '<p class="meta"><a href="#/signin">Sign in</a> to leave a review after you have messaged one of their homes.</p>';
  } else if (!data.canReview) {
    reviewBox = isOwner
      ? ''
      : '<p class="meta">You can review this owner after you message one of their homes with your account email.</p>';
  } else {
    reviewBox = `<form class="review-form" id="reviewForm">
      <h2 class="section-title">${data.myReview ? 'Update your review' : 'Leave a review'}</h2>
      <div class="star-picker" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5]
        .map((n) => `<button type="button" class="star" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
      <textarea name="comment" rows="3" maxlength="500" placeholder="How was it? (optional)" aria-label="Your comment">${esc(data.myReview?.comment ?? '')}</textarea>
      <button class="primary" type="submit">Send review</button>
    </form>`;
  }

  view.innerHTML = `<section class="head owner-head">
      <div>
        <span class="tag">Host profile</span>
        <h1>${esc(o.name)}</h1>
        <p class="owner-rating"><span class="stars big" aria-label="${o.rating ?? 0} out of 5">${starsOf(o.rating)}</span>
          ${o.rating !== null ? `<strong>${esc(o.rating)}</strong>` : '<span class="meta">New</span>'}
          <span class="meta">${o.count} ${o.count === 1 ? 'review' : 'reviews'}</span></p>
        ${o.trusted ? '<span class="tag verified">Trusted owner</span>' : ''}
      </div>
    </section>
    <h2 class="section-title">Homes</h2>
    <div class="grid">${data.listings.map(card).join('') || '<div class="empty-state"><span>🏡</span><p>No homes listed right now.</p></div>'}</div>
    <h2 class="section-title">Reviews</h2>
    <div class="reviews">${reviewsHtml}</div>
    <section class="review-box">${reviewBox}</section>`;

  let chosen = data.myReview?.stars ?? 0;
  const paintStars = (): void => {
    view.querySelectorAll<HTMLButtonElement>('.star').forEach((button) => {
      button.classList.toggle('on', Number(button.dataset.star) <= chosen);
    });
  };
  paintStars();
  view.querySelectorAll<HTMLButtonElement>('.star').forEach((button) => {
    button.addEventListener('click', () => {
      chosen = Number(button.dataset.star);
      paintStars();
      button.classList.remove('pop');
      void button.offsetWidth;
      button.classList.add('pop');
    });
  });
  document.getElementById('reviewForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!chosen) {
      toast('Tap a star rating first.', 'warn');
      return;
    }
    const comment = (form.elements.namedItem('comment') as HTMLTextAreaElement).value;
    try {
      await api(`/api/owners/${o.id}/reviews`, { method: 'POST', json: { stars: chosen, comment } });
      toast('Thank you for your review!');
      await ownerPage(id);
    } catch (err) {
      toast((err as Error).message, 'warn');
    }
  });
  view.querySelectorAll<HTMLFormElement>('.reply-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = (form.elements.namedItem('reply') as HTMLTextAreaElement).value.trim();
      if (!text) {
        toast('Write a reply first.', 'warn');
        return;
      }
      try {
        await api(`/api/reviews/${form.dataset.reply}/reply`, { method: 'POST', json: { text } });
        toast('Reply posted.');
        await ownerPage(id);
      } catch (err) {
        toast((err as Error).message, 'warn');
      }
    });
  });
  view.querySelectorAll<HTMLButtonElement>('[data-hide]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/admin/reviews/${button.dataset.hide}/hide`, { method: 'POST' });
      toast('Review hidden.');
      await ownerPage(id);
    });
  });
}

async function adminPage(): Promise<void> {
  if (me?.role !== 'admin') {
    view.innerHTML = '<p class="empty">This page is for the review team.</p>';
    return;
  }
  const [{ listings }, { reports }] = await Promise.all([
    api<{ listings: Listing[] }>('/api/admin/listings?status=pending'),
    api<{ reports: { id: number; reason: string; details: string; created_at: string; listing_id: number; address: string }[] }>('/api/admin/reports'),
  ]);
  const CHECKS: { key: 'photos' | 'address' | 'price' | 'owner'; label: string }[] = [
    { key: 'photos', label: 'Photos checked (reverse image search)' },
    { key: 'address', label: 'Address checked on maps' },
    { key: 'price', label: 'Price compared with similar homes' },
    { key: 'owner', label: 'Ownership proof reviewed' },
  ];
  const REASON: Record<string, string> = {
    fake: 'Looks fake', scam: 'Asked for money', wrong_details: 'Wrong details',
    sold_or_rented: 'Already sold or rented', other: 'Other',
  };
  view.innerHTML = `<section class="head"><h1>Review new homes</h1>
      <p class="lede">${listings.length} waiting for a decision. Tick all four checks before you approve. A home shows the Verified badge only after it is approved with every check ticked.</p></section>
    <div class="list">${listings.map((l) => {
      const c = l.checks;
      const allTicked = c !== null && c !== undefined && c.photos === 1 && c.address === 1 && c.price === 1 && c.owner === 1;
      return `<div class="review-card" data-id="${l.id}">
        <div class="strip">${(l.photos ?? []).map((src) => `<img src="${esc(src)}" alt="" />`).join('')}</div>
        <div class="review-body">
          <p class="price">${esc(money(l))}</p>
          <h3>${esc(l.address)}</h3>
          <p class="meta">${esc(l.area)} · ${esc(l.type)} · listing ${l.id}</p>
          <div class="checks">${CHECKS.map(({ key, label }) => `<label class="check"><input type="checkbox" data-check="${key}" ${c && c[key] === 1 ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}</div>
          <textarea class="note-box" rows="3" maxlength="1000" placeholder="Reviewer note: what you checked and anything to follow up" aria-label="Reviewer note">${esc(c?.note ?? '')}</textarea>
          <div class="docs">${(l.documents ?? []).map((d) => `<a href="/api/admin/documents/${d.id}" target="_blank" rel="noopener">${esc(d.original_name)}</a>`).join('') || '<span class="meta">No ownership documents uploaded</span>'}</div>
          ${c?.reviewed_by ? `<p class="meta">Last checked by ${esc(c.reviewed_by)}${c.reviewed_at ? ` · ${esc(c.reviewed_at)}` : ''}</p>` : ''}
          <div class="row">
            <button class="ghost" type="button" data-save-checks="${l.id}">Save checks</button>
            <button class="primary" type="button" data-set="approved" data-id="${l.id}"${allTicked ? '' : ' disabled'}>Approve</button>
            <button class="ghost" type="button" data-set="rejected" data-id="${l.id}">Reject</button>
          </div>
        </div>
      </div>`;
    }).join('') || '<p class="empty">Nothing is waiting.</p>'}</div>
    <section class="head"><h2>Reports from visitors</h2></section>
    <div class="list">${reports.map((r) => `
      <div class="row-item">
        <div><p class="status">${esc(REASON[r.reason] ?? r.reason)}</p><h3>${esc(r.address)}</h3>
          <p class="meta">${esc(r.details || 'No details given')} · listing ${r.listing_id} · ${esc(r.created_at)}</p></div>
        <button class="primary" type="button" data-report="${r.id}" data-status="resolved">Resolved</button>
        <button class="ghost" type="button" data-report="${r.id}" data-status="dismissed">Dismiss</button>
      </div>`).join('') || '<p class="empty">No open reports.</p>'}</div>`;

  view.querySelectorAll<HTMLElement>('.review-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector<HTMLButtonElement>('[data-save-checks]')?.addEventListener('click', async () => {
      const body: Record<string, unknown> = {
        note: card.querySelector<HTMLTextAreaElement>('.note-box')?.value ?? '',
      };
      card.querySelectorAll<HTMLInputElement>('[data-check]').forEach((box) => {
        body[box.dataset.check ?? ''] = box.checked;
      });
      await api(`/api/admin/listings/${id}/checks`, { method: 'PUT', json: body });
      await adminPage();
    });
  });
  view.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/admin/listings/${button.dataset.id}/status`, { method: 'POST', json: { status: button.dataset.set } });
        await adminPage();
      } catch (err) {
        alert((err as Error).message);
      }
    });
  });
  view.querySelectorAll<HTMLButtonElement>('[data-report]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/admin/reports/${button.dataset.report}/status`, { method: 'POST', json: { status: button.dataset.status } });
      await adminPage();
    });
  });
}

async function route(): Promise<void> {
  resetMap();
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  pendingFilters = new URLSearchParams(query);
  const [page = 'listings', id = ''] = path.split('/');
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#/${page}`));
  view.innerHTML = skeleton();
  try {
    switch (page) {
      case 'listing': await listingPage(id); break;
      case 'add': listingForm(null); break;
      case 'edit': await editPage(id); break;
      case 'mine': await minePage(); break;
      case 'saved': await savedPage(); break;
      case 'owner': await ownerPage(id); break;
      case 'admin': await adminPage(); break;
      case 'signin': view.innerHTML = signInPrompt('Choose how you want to sign in.'); break;
      case 'privacy': location.replace('/privacy.html'); break;
      case 'terms': location.replace('/terms.html'); break;
      default: await listingsPage();
    }
  } catch (err) {
    view.innerHTML = `<p class="empty">${esc((err as Error).message)}</p>`;
  }
}

window.addEventListener('hashchange', () => { route().catch(() => undefined); });
// The glass shine follows the finger or the mouse across each button and card.
const trackShine = (event: PointerEvent): void => {
  if (!(event.target instanceof Element)) return;
  const el = event.target.closest<HTMLElement>('.primary, .ghost, .pill, .chip, .provider, .glass-btn, .app-nav a, .card');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  el.style.setProperty('--my', `${event.clientY - rect.top}px`);
};
document.addEventListener('pointerdown', trackShine);
document.addEventListener('pointermove', trackShine);
// iPhone Safari only shows :active styles when the page listens for touches.
document.addEventListener('touchstart', () => undefined, { passive: true });

(async () => {
  try {
    me = (await api<{ user: Me }>('/api/me')).user;
  } catch {
    me = null;
  }
  renderNav();
  await route();
})();
