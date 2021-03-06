import {profile} from '../../profiler/decorator';
import {Overlord} from '../Overlord';
import {Zerg} from '../../Zerg';
import {Pathing} from '../../pathing/pathing';
import {Directive} from '../../directives/Directive';
import {WorldMap} from '../../utilities/WorldMap';
import {AttackStructurePriorities} from '../../settings/priorities';

export interface CombatOverlordMemory extends OverlordMemory {
	fallback?: protoPos;
}

@profile
export abstract class CombatOverlord extends Overlord {

	memory: CombatOverlordMemory;
	directive: Directive;
	moveOpts: TravelToOptions;

	constructor(directive: Directive, name: string, priority: number) {
		super(directive, name, priority);
		this.directive = directive;
		this.moveOpts = {
			allowSK     : true,
			allowHostile: true,
			ensurePath  : true,
		};
	}

	pairwiseMove(leader: Zerg, follower: Zerg, target: HasPos | RoomPosition,
				 opts: TravelToOptions = this.moveOpts, allowedRange = 1): number | undefined {
		let outcome;
		if (leader.room != follower.room) {
			if (leader.pos.rangeToEdge == 0) {
				// Leader should move off of exit tiles while waiting for follower
				outcome = leader.travelTo(target, opts);
			}
			follower.travelTo(leader);
			return outcome;
		}

		let range = leader.pos.getRangeTo(follower);
		if (range > allowedRange) {
			// If leader is farther than max allowed range, allow follower to catch up
			if (follower.pos.rangeToEdge == 0 && follower.room == leader.room) {
				follower.moveOffExitToward(leader.pos);
			} else {
				follower.travelTo(leader, {stuckValue: 1});
			}
		} else if (follower.fatigue == 0) {
			// Leader should move if follower can also move this tick
			outcome = leader.travelTo(target, opts);
			if (range == 1) {
				follower.move(follower.pos.getDirectionTo(leader));
			} else {
				follower.travelTo(leader, {stuckValue: 1});
			}
		}
		return outcome;
	}

	findPartner(zerg: Zerg, partners: Zerg[], tickDifference = 600): Zerg | undefined {
		if (zerg.memory.partner) {
			let partner = _.find(partners, partner => partner.name == zerg.memory.partner);
			if (partner) {
				return partner;
			} else {
				delete zerg.memory.partner;
				this.findPartner(zerg, partners, tickDifference);
			}
		} else {
			let partner = _.find(partners, partner => partner.memory.partner == zerg.name);
			if (!partner) {
				partner = _(partners)
					.filter(partner => !partner.memory.partner && !partner.spawning &&
									   Math.abs(zerg.ticksToLive! - partner.ticksToLive!) <= tickDifference)
					.min(partner => Math.abs(zerg.ticksToLive! - partner.ticksToLive!));
			}
			if (_.isObject(partner)) {
				zerg.memory.partner = partner.name;
				partner.memory.partner = zerg.name;
				return partner;
			}
		}
	}

	findClosestHostile(zerg: Zerg, checkReachable = false, ignoreCreepsAtEdge = true): Creep | undefined {
		if (zerg.room.hostiles.length > 0) {
			let targets: Creep[];
			if (ignoreCreepsAtEdge) {
				targets = _.filter(zerg.room.hostiles, hostile => hostile.pos.rangeToEdge > 0);
			} else {
				targets = zerg.room.hostiles;
			}
			if (checkReachable) {
				let targetsByRange = _.sortBy(targets, target => zerg.pos.getRangeTo(target));
				return _.find(targetsByRange, target => Pathing.isReachable(zerg.pos, target.pos));
			} else {
				return zerg.pos.findClosestByRange(targets);
			}

		}
	}

	findClosestReachable(pos: RoomPosition, targets: (Creep | Structure)[]): Creep | Structure | undefined {
		let targetsByRange = _.sortBy(targets, target => pos.getRangeTo(target));
		return _.find(targetsByRange, target => Pathing.isReachable(pos, target.pos));
	}

	findClosestPrioritizedStructure(zerg: Zerg, checkReachable = false): Structure | undefined {
		for (let structureType of AttackStructurePriorities) {
			let structures = _.filter(zerg.room.hostileStructures, s => s.structureType == structureType);
			if (structures.length == 0) continue;
			if (checkReachable) {
				let closestReachable = this.findClosestReachable(zerg.pos, structures) as Structure | undefined;
				if (closestReachable) return closestReachable;
			} else {
				return zerg.pos.findClosestByRange(structures);
			}
		}
	}

	findClosestHurtFriendly(healer: Zerg): Creep | undefined {
		return healer.pos.findClosestByRange(_.filter(healer.room.creeps, creep => creep.hits < creep.hitsMax));
	}

	/* Move to and heal/rangedHeal the specified target */
	medicActions(healer: Zerg): void {
		let target = this.findClosestHurtFriendly(healer);
		if (target) {
			// Approach the target
			let range = healer.pos.getRangeTo(target);
			if (range > 1) {
				healer.travelTo(target, {movingTarget: true});
			}

			// Heal or ranged-heal the target
			if (range <= 1) {
				healer.heal(target);
			} else if (range <= 3) {
				healer.rangedHeal(target);
			}
		} else {
			healer.park();
		}
	}

	healSelfIfPossible(zerg: Zerg): CreepActionReturnCode | undefined {
		// Heal yourself if it won't interfere with attacking
		if (zerg.hits < zerg.hitsMax && zerg.canExecute('heal')) {
			return zerg.heal(zerg);
		}
	}

	/* Attack and chase the specified target */
	attackAndChase(zerg: Zerg, target: Creep | Structure): CreepActionReturnCode {
		let ret: CreepActionReturnCode;
		// Attack the target if you can, else move to get in range
		if (zerg.pos.isNearTo(target)) {
			ret = zerg.attack(target);
			// Move in the direction of the creep to prevent it from running away
			zerg.move(zerg.pos.getDirectionTo(target));
			return ret;
		} else {
			if (target instanceof Creep) {
				zerg.travelTo(target, _.merge(this.moveOpts, {movingTarget: true}));
			} else {
				zerg.travelTo(target, this.moveOpts);
			}
			return ERR_NOT_IN_RANGE;
		}

	}

	/* Fallback is a location on the other side of the nearest exit the directive is placed at */
	get fallback(): RoomPosition {
		let rangesToExit = [
			[this.directive.pos.x, 'left'],
			[49 - this.directive.pos.x, 'right'],
			[this.directive.pos.y, 'top'],
			[49 - this.directive.pos.y, 'bottom'],
		];
		let fallback = _.clone(this.directive.pos);
		let roomCoords = this.directive.pos.roomCoords;
		let [range, direction] = _.first(_.sortBy(rangesToExit, pair => pair[0]));
		switch (direction) {
			case 'left':
				fallback.x = 48;
				fallback.roomName = WorldMap.findRelativeRoomName(fallback.roomName, -1, 0);
				break;
			case 'right':
				fallback.x = 1;
				fallback.roomName = WorldMap.findRelativeRoomName(fallback.roomName, 1, 0);
				break;
			case 'top':
				fallback.y = 48;
				fallback.roomName = WorldMap.findRelativeRoomName(fallback.roomName, 0, -1);
				break;
			case 'bottom':
				fallback.y = 1;
				fallback.roomName = WorldMap.findRelativeRoomName(fallback.roomName, 0, 1);
				break;
			default:
				console.log('Error getting fallback position!');
				break;
		}
		return fallback;
	}

}