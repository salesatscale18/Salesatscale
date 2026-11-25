/**
 * The top of the hosted form and the hand-over (decisions 1 and 2): the seller's
 * banner shown whole (its own proportions, at most 40vh, nothing drawn over it,
 * the space reserved by its width and height so nothing jumps), or, without a
 * banner, a large initials tile in the brand colour with the seller's name.
 */
export function LeadPageHeader({ banner, seller, initials }: {
  banner: { src: string; width: number; height: number } | null;
  seller: string;
  initials: string;
}) {
  if (banner) {
    return (
      <div className="lp-banner" style={{ aspectRatio: `${banner.width} / ${banner.height}` }} data-lp-banner="">
        {/* A plain img: the route serves the private blob with an immutable cache; no image optimiser config needed. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={banner.src} width={banner.width} height={banner.height} alt={seller} decoding="async" fetchPriority="high" />
      </div>
    );
  }
  return (
    <div className="lp-brand" data-lp-tile="">
      <span className="lp-tile" aria-hidden="true">{initials}</span>
      <span className="lp-brand__name"><bdi>{seller}</bdi></span>
    </div>
  );
}
