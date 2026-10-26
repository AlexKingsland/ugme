/**
 * The content usage rights agreement — shown to merchants when they set up a
 * wall campaign and to customers before they share. One source of truth so
 * both sides always see the same terms.
 */
export const USAGE_RIGHTS_INTRO = "By sharing content, the creator agrees that:";

export function usageRightsClauses(brand: string): string[] {
  return [
    "The content is original and was created by them.",
    `They grant ${brand} a perpetual, non-exclusive, royalty-free license to use, reproduce, modify, and distribute the content.`,
    `${brand} may use the content on its website, social media, email marketing, paid advertising, and any other marketing channels.`,
    `${brand} may edit, crop, or modify the content to fit different formats and platforms.`,
    "The creator keeps ownership of the original content and may continue to use it personally.",
    "The creator waives any right to inspect or approve the final use of the content.",
    "The creator has the rights to any people, locations, or property featured in the content.",
  ];
}
