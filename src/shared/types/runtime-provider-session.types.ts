export interface RuntimeProviderChoice {
  provider: `plugin:${string}`;
  name: string;
}

export interface RuntimeProviderList {
  providers: RuntimeProviderChoice[];
  failures: string[];
}

export interface RuntimeProviderReply {
  content: string;
}
