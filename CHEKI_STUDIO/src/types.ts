export type Cheki = {
  id: string;
  name: string;
  image: string;
  createdAt?: number;
};
export type GiftEvent = {
  type: "show-cheki";
  cheki: Cheki;
  giftName?: string;
  userName?: string;
  giftId?: string;
  at: number;
  isTest?: boolean;
};