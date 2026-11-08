// View models consumed by the server-rendered pages. Route handlers build these from D1;
// views never touch the database. All money values are integer minor units.

export type BoardCode = 'daily' | 'weekly' | 'monthly';

export interface Viewer {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface LayoutContext {
  title: string;
  description?: string;
  /** Absolute path of the current page, used for active nav and canonical. */
  path: string;
  viewer: Viewer | null;
  /** True when payments run in simulated or sandbox mode. Shown as a banner. */
  testMode: boolean;
  /** Absolute public origin, e.g. https://bip-ad.digitop-vn.workers.dev */
  origin: string;
}

export interface BoardRow {
  rank: number;
  productId: string;
  slug: string;
  name: string;
  tagline: string;
  /** Active bid in rank units (USD cents equivalent). 0 = free listing. */
  activeRankUnits: number;
  ownerSuccessfulReferrals: number;
  validClicks: number;
  validViews: number;
  /** True for seeded demo products; the UI labels them "sample". */
  isSample: boolean;
  /** Absolute or root-relative logo/image URL, may be null. */
  imageUrl: string | null;
}

export interface BoardView {
  board: BoardCode;
  /** ISO timestamp of the next 03:12 ICT lock. */
  nextCutoffAt: string;
  /** Paid rows first, ordered by the ranking policy, then free rows. */
  rows: BoardRow[];
  rankingPolicyVersion: string;
}

export interface HomeView {
  boards: Record<BoardCode, BoardView>;
  active: BoardCode;
  /** Most recent snapshot date per board (yyyy-mm-dd ICT), for "last lock" links. */
  lastSnapshotDate: Partial<Record<BoardCode, string>>;
  mcpUrl: string;
}

export type WidgetBlock =
  | { type: 'hero'; headline: string; subheadline?: string; image_url?: string }
  | { type: 'gallery'; images: { url: string; alt: string }[] }
  | { type: 'video'; url: string; title?: string }
  | { type: 'feature_grid'; title?: string; features: { title: string; body: string }[] }
  | { type: 'rich_text'; markdown: string }
  | { type: 'call_to_action'; label: string; url: string; note?: string }
  | { type: 'pricing'; title?: string; plans: { name: string; price: string; features: string[] }[] }
  | { type: 'testimonials'; items: { quote: string; author: string }[] }
  | { type: 'faq'; items: { q: string; a: string }[] }
  | { type: 'founder_note'; body: string; author: string }
  | { type: 'links'; items: { label: string; url: string }[] }
  | { type: 'metrics'; items: { label: string; value: string }[] };

export interface ProductPageView {
  productId: string;
  slug: string;
  name: string;
  tagline: string;
  websiteUrl: string;
  /** Root-relative tracked outbound URL (/go/{slug}). Always use this for the visit link. */
  outboundPath: string;
  isSample: boolean;
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'suspended';
  /** Set when rendering an unpublished preview. */
  previewVersion: number | null;
  pageVersion: number | null;
  blocks: WidgetBlock[];
  standings: { board: BoardCode; rank: number | null; activeRankUnits: number }[];
  ownerSuccessfulReferrals: number;
}

export interface SnapshotItemView {
  rank: number;
  slug: string;
  name: string;
  rankUnits: number;
  ownerSuccessfulReferrals: number;
  validClicks: number;
  validViews: number;
  visibilityState: 'visible' | 'removed_from_publication';
  isSample: boolean;
}

export interface SnapshotView {
  board: BoardCode;
  date: string; // yyyy-mm-dd (ICT)
  cutoffAt: string; // ISO
  executedAt: string; // ISO
  rankingPolicyVersion: string;
  items: SnapshotItemView[];
  /** Mock media adapters: status is shown verbatim (e.g. "mocked"). */
  media: { kind: string; platform: string | null; status: string; url: string | null }[];
  cohort: { currency: string; eligibleRevenueMinor: number; adsFundMinor: number; commissionMinor: number; operatorMinor: number }[];
  prevDate: string | null;
  nextDate: string | null;
}

export interface MoneyLine {
  currency: string;
  minor: number;
}

export interface AccountView {
  viewer: Viewer;
  products: { slug: string; name: string; status: string; standings: { board: BoardCode; rank: number | null; activeRankUnits: number }[] }[];
  payments: { createdAt: string; board: BoardCode; productName: string; currency: string; amountMinor: number; provider: string; state: string }[];
  referral: { code: string; link: string; successful: number; pending: number };
  wallet: { pending: MoneyLine[]; available: MoneyLine[]; reservedForBid: MoneyLine[]; reservedForPayout: MoneyLine[]; paid: MoneyLine[] };
  walletHistory: { at: string; currency: string; deltaMinor: number; memo: string }[];
  payouts: { requestedAt: string; currency: string; requestedMinor: number; state: string; transferReference: string | null }[];
  mcpUrl: string;
}

export interface CheckoutView {
  intentId: string;
  status: string;
  productName: string;
  productSlug: string;
  board: BoardCode;
  rankUnits: number;
  quoteCurrency: string;
  quoteMinor: number;
  walletAppliedMinor: number;
  /** Amount still due from an external provider after wallet. */
  dueMinor: number;
  fxRate: number | null;
  quoteExpiresAt: string;
  activeHours: number;
  /** Projected rank on that board if paid now. */
  projectedRank: number;
  /** Which providers can pay this currency. */
  providers: ('paypal' | 'sepay')[];
  paymentMode: 'simulated' | 'sandbox' | 'live';
  isOwner: boolean;
  /** CSRF token for the POST forms on this page. */
  csrf: string;
  message: string | null;
}
