export interface FeederInfo {
    id: string;
    name: string;
    enabled: boolean;
    lastActive: number;
    interval: string;
    estRemainingFood: number;
    estRemainingFeedings: number;
	estFoodPerFeeding: number;
	description: string;
	skipNext: boolean;
	pin: number;
	duration: number;
}