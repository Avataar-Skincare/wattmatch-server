'use strict';

// Restart resilience: without a live-updated mirror of who's currently leading, a Redis state loss
// (restart without persistence, eviction) can only be recovered using the price (current_lowest_bid
// already mirrors that) — the leader identity would be silently lost, and an auction that never
// receives another bid after recovery would close with no winner despite a real leader existing.
// Mirrored on every accepted bid, same pattern as current_lowest_bid.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auctions', 'current_leader_participant_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_auctions', 'current_leader_alias', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auctions', 'current_leader_alias');
    await queryInterface.removeColumn('wattmatch_auctions', 'current_leader_participant_id');
  },
};
