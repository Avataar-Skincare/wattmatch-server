'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wattmatch_auction_participants', 'rules_accepted_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_auctions', 'result_summary_json', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('wattmatch_auctions', 'result_hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wattmatch_auctions', 'result_hash');
    await queryInterface.removeColumn('wattmatch_auctions', 'result_summary_json');
    await queryInterface.removeColumn('wattmatch_auction_participants', 'rules_accepted_at');
  },
};
