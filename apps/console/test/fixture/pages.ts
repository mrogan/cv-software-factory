/**
 * Invented pages for the console's milestone 4 test data: a shop that looks enough like a shop for the console's
 * pictures to be judged, written here and never taken from the app. Every fault on them is made up for the tests,
 * and none is one of the app's defects.
 */

/** What every page shares: a header, a heading, and a footer whose text is too faint to read. */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} · Mossop’s Practical Sundries</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #faf6ec; color: #1f2a22; font: 17px/1.5 Georgia, serif; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin: 0 64px;
    padding: 28px 0 14px; border-bottom: 3px double #1f4a2c; }
  header b { font-size: 28px; font-weight: normal; }
  nav { display: flex; gap: 22px; font-size: 16px; }
  nav a { color: #a2391a; }
  main { margin: 34px 64px 0; display: grid; grid-template-columns: 1fr 380px; gap: 56px; }
  h1 { margin: 0 0 14px; font-size: 36px; font-weight: normal; }
  p { margin: 0 0 14px; max-width: 560px; }
  a { color: #a2391a; }
  .art { border: 1px solid #d8d0bd; border-radius: 4px; background: #fffdf6; height: 220px;
    display: grid; place-items: center; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 20px; }
  .tile { border: 1px solid #d8d0bd; background: #fffdf6; padding: 16px; height: 150px; }
  .tile b { display: block; font-weight: normal; }
  .price { font: 22px/1 Georgia, serif; margin-top: 8px; }
  form { display: grid; gap: 10px; max-width: 460px; }
  label { font-size: 14px; }
  input, textarea { font: inherit; padding: 8px; border: 1px solid #b9b09b; background: #fffdf6; }
  button { justify-self: start; font: inherit; padding: 8px 20px; background: #1f4a2c; color: #faf6ec; border: 0; }
  .error { border: 2px solid #a2391a; background: #fbe9e2; padding: 12px 16px; max-width: 460px; }
  .error b { display: block; font-weight: normal; font-size: 20px; }
  .pictures { display: flex; gap: 18px; }
  .pictures img { width: 170px; height: 120px; border: 1px solid #d8d0bd; background: #fffdf6; }
  .badge { margin-top: 520px; }
  footer { position: absolute; left: 64px; right: 64px; top: 744px; border-top: 1px solid #e3dccb; padding-top: 10px; }
  footer p { display: inline-block; margin: 0; color: #d6cfbf; font-size: 14px; }
</style>
</head>
<body>
<header><b>Mossop’s Practical Sundries</b><nav><a href="/products">Shop</a><a href="/about">About</a><a href="/contact">Contact</a></nav></header>
<main>${body}</main>
<footer><p data-mark="footer">© Mossop’s · terms · privacy · delivery</p></footer>
</body>
</html>`;

/** A drawing for a page's picture: a house, a van or a map, in the shop's own ink. */
const drawing = (name: 'house' | 'van' | 'map' | 'badge') =>
  ({
    house:
      '<svg width="120" height="90" viewBox="0 0 120 90" fill="none" stroke="#1f4a2c" stroke-width="3"><path d="M10 45 60 8l50 37M22 36v46h76V36M48 82V56h24v26"/></svg>',
    van: '<svg width="120" height="70" viewBox="0 0 120 70" fill="none" stroke="#1f4a2c" stroke-width="3"><path d="M6 14h66v34H6zM72 26h22l14 14v8H72z"/><circle cx="26" cy="54" r="7"/><circle cx="90" cy="54" r="7"/></svg>',
    map: '<svg width="120" height="80" viewBox="0 0 120 80" fill="none" stroke="#1f4a2c" stroke-width="3"><path d="M8 14 40 6l40 8 32-8v60l-32 8-40-8-32 8zM40 6v60M80 14v60"/></svg>',
    badge:
      '<svg width="90" height="90" viewBox="0 0 90 90" fill="none" stroke="#1f4a2c" stroke-width="3"><circle cx="45" cy="45" r="34"/><path d="M30 46l10 10 20-22"/></svg>',
  })[name];

/** An image with no alternative text: the drawing as its source, and nothing for a screen reader. */
const image = (name: 'van' | 'map' | 'badge') =>
  `<img class="${name}" src="data:image/svg+xml,${encodeURIComponent(drawing(name).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}">`;

export interface InventedPage {
  name: string;
  route: string;
  html: string;
}

export const PAGES: InventedPage[] = [
  {
    name: 'home',
    route: '/',
    html: page(
      'Home',
      `<div><h1>This week</h1><p>Useful things, and a few unlikely ones.</p>
      <div class="tiles">
        <div class="tile"><b>Doorstop, cast iron</b><div class="price">£18.00</div></div>
        <div class="tile"><b>String, fifty metres</b><div class="price">£3.20</div></div>
        <div class="tile"><b>Spirit level</b><div class="price">£12.50</div></div>
      </div></div><div class="art">${drawing('house')}</div>`,
    ),
  },
  {
    name: 'about',
    route: '/about',
    html: page(
      'About',
      `<div><h1>About the shop</h1>
      <p>Mossop’s has sold the useful and the unlikely since 1887. Everything we stock has been used by somebody, at least once, on purpose.</p>
      <p>Serving the town since 1903, from the same counter.</p>
      <p>Orders leave the warehouse within two working days. For the small print, read
      <a href="/delivery-promise" data-mark="link">our delivery promise</a>.</p></div>
      <div class="art">${drawing('house')}</div>`,
    ),
  },
  {
    name: 'contact',
    route: '/contact',
    html: page(
      'Contact',
      `<div><h1>Contact</h1><p>Write to us. Somebody reads every message.</p>
      <div class="error" data-mark="error"><b>Something went wrong</b>Please try again later.</div>
      <form><label>Your name<br><input value="A. Customer"></label>
      <label>Your message<br><textarea rows="3">Do you stock left-handed scissors?</textarea></label>
      <button type="button">Send</button></form></div>
      <div class="art">${drawing('house')}</div>`,
    ),
  },
  {
    name: 'delivery',
    route: '/delivery',
    html: page(
      'Delivery',
      `<div><h1>Delivery</h1><p>Two working days, anywhere in the county. Further afield, a little longer.</p>
      <div class="pictures">${image('van')}${image('map')}</div>
      <div class="badge">${image('badge')}</div></div><div></div>`,
    ),
  },
  {
    name: 'gift-cards',
    route: '/gift-cards',
    html: page(
      'Gift cards',
      `<div><h1>Gift cards</h1><p>For the person who has everything, and still needs string.</p>
      <div class="tiles"><div class="tile"><b>Ten pounds</b><div class="price">£10.00</div></div>
      <div class="tile"><b>Twenty-five pounds</b><div class="price">£25.00</div></div></div></div>
      <div class="art">${drawing('badge')}</div>`,
    ),
  },
  {
    name: 'wishlist',
    route: '/wishlist',
    html: page('Wishlist', `<div><h1>Your wishlist</h1><p>Nothing here yet.</p></div><div></div>`),
  },
  {
    name: 'doorstop',
    route: '/products/doorstop',
    html: page(
      'Doorstop, cast iron',
      `<div><h1>Doorstop, cast iron</h1><p>Heavy. Stops doors. Will outlast the door.</p>
      <div class="price">£18.00</div></div><div class="art">${drawing('badge')}</div>`,
    ),
  },
];
