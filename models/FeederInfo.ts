export interface FeederInfo {
    id: string;
    name: string;
    status: 'ONLINE' | 'OFFLINE';
    lastActive: number;
    nextActive: number;
    interval: string;
    estRemainingFood: number;
    estRemainingFeedings: number;
	estFoodPerFeeding: number;
	description: string;
}