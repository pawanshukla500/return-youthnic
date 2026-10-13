// Single list of marketplaces for dropdowns and badges.
// Before this file, the list was typed out in three places (scan dropdown, upload dropdown,
// badge colours). Add a marketplace here and it appears everywhere in the UI.
// Names must match the marketplaces table in server/seed.ts.
export const MARKETPLACES = ["Amazon", "Flipkart", "Meesho", "Myntra VB", "Myntra EJ", "Ajio", "Shopify"] as const

export type MarketplaceName = (typeof MARKETPLACES)[number]

// CSS class for each marketplace badge colour. Myntra VB and EJ share the Myntra colour.
export const MARKETPLACE_CLASS: Record<string, string> = {
  Amazon: "amazon",
  Flipkart: "flipkart",
  Meesho: "meesho",
  "Myntra VB": "myntra",
  "Myntra EJ": "myntra",
  Ajio: "ajio",
  Shopify: "shopify",
}

// Square marks saved for accounts.
export const MARKETPLACE_LOGO: Record<string, string> = {
  Amazon: "/logos/amazon.jpg",
  Flipkart: "/logos/flipkart.jpg",
  Meesho: "/logos/meesho.png",
  "Myntra VB": "/logos/myntra.png",
  "Myntra EJ": "/logos/myntra.png",
  Ajio: "/logos/ajio.jpg",
  Shopify: "/logos/shopify.svg",
}
