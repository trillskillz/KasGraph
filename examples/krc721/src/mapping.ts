// Native KRC-721 mapping handlers.

import type {
  CollectionDeployedEvent,
  NftMintedEvent,
  NftTransferredEvent,
  NftBurnedEvent,
} from './generated/events.js';

/**
 * Fires when a collection covenant first appears on-chain.
 */
export async function handleCollectionDeployed(
  event: CollectionDeployedEvent,
): Promise<void> {
  void event;
  // Pseudo-code:
  //   const c = new KRC721Collection(event.payload.collectionCovenantId);
  //   c.collectionCovenantId  = event.payload.collectionCovenantId;
  //   c.name                  = event.payload.name;
  //   c.mintAuthorityPubkey   = event.payload.mintAuthorityPubkey ?? null;
  //   c.baseUri               = event.payload.baseUri ?? null;
  //   c.maxSupply             = event.payload.maxSupply;
  //   c.mintedSupply          = 0n;
  //   c.burnedSupply          = 0n;
  //   c.holderCount           = 0;
  //   c.deployedAtDaa         = event.block.daaScore;
  //   await c.save();
}

/**
 * Fires on the genesis (mint) of a per-NFT covenant. Creates the
 * Token, bumps collection.mintedSupply, and credits the holder.
 */
export async function handleNftMinted(event: NftMintedEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const col = await KRC721Collection.load(event.payload.collectionCovenantId);
  //   if (col === null) return;
  //   const t = new KRC721Token(event.payload.tokenCovenantId);
  //   t.collection      = col.id;
  //   t.tokenCovenantId = event.payload.tokenCovenantId;
  //   t.tokenId         = event.payload.tokenId;
  //   t.metadataUri     = event.payload.metadataUri ?? null;
  //   t.mintedAtDaa     = event.block.daaScore;
  //   t.burned          = false;
  //   t.transferCount   = 0;
  //   await t.save();
  //   col.mintedSupply += 1n;
  //   await col.save();
  //   // credit holder balance + emit KRC721Mint
}

/**
 * Fires on a per-NFT covenant lineage transition that changes
 * ownership. Debits the sender, credits the receiver, emits a
 * KRC721Transfer.
 */
export async function handleNftTransferred(
  event: NftTransferredEvent,
): Promise<void> {
  void event;
  // Pseudo-code:
  //   const t = await KRC721Token.load(event.payload.tokenCovenantId);
  //   if (t === null || t.burned) return;
  //   // from = current owner, to = event.payload.toPubkey
  //   t.owner = toHolder.id;
  //   t.transferCount += 1;
  //   await t.save();
  //   // adjust both holder balances + emit KRC721Transfer
}

/**
 * Fires when a per-NFT covenant is spent into a burn sink. Marks
 * the token burned and bumps collection.burnedSupply.
 */
export async function handleNftBurned(event: NftBurnedEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const t = await KRC721Token.load(event.payload.tokenCovenantId);
  //   if (t === null || t.burned) return;
  //   t.burned = true;
  //   await t.save();
  //   const col = await KRC721Collection.load(t.collection);
  //   col.burnedSupply += 1n;
  //   await col.save();
  //   // debit the burner's holder balance
}
