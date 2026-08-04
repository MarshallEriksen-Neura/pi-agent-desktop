export interface ExternalNavigationPort {
  open(url: string): Promise<void>;
}
