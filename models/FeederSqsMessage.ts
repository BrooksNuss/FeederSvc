export interface FeederSqsMessage {
	type: FeederApiType;
	id: string;
}

export type FeederApiType = 'activate' | 'list-info' | 'skip' | 'toggle-enabled';