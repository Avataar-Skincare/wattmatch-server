'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_auctions', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      title: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.ENUM('scheduled', 'live', 'closed'), allowNull: false, defaultValue: 'scheduled' },
      opening_bid: { type: Sequelize.DECIMAL(10, 4), allowNull: false },
      current_lowest_bid: { type: Sequelize.DECIMAL(10, 4), allowNull: true },
      window_seconds: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 480 },
      max_auto_extensions: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 8 },
      current_extension_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      window_ends_at: { type: Sequelize.DATE, allowNull: true },
      winner_participant_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('wattmatch_auction_participants', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      auction_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      organization_name: { type: Sequelize.STRING, allowNull: false },
      alias: { type: Sequelize.STRING, allowNull: false },
      join_token_id: { type: Sequelize.STRING, allowNull: false, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('wattmatch_auction_participants', ['auction_id']);

    await queryInterface.createTable('wattmatch_auction_bids', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      auction_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      participant_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      alias: { type: Sequelize.STRING, allowNull: false },
      amount: { type: Sequelize.DECIMAL(10, 4), allowNull: false },
      accepted: { type: Sequelize.BOOLEAN, allowNull: false },
      reject_reason: { type: Sequelize.STRING, allowNull: true },
      ip_hash: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('wattmatch_auction_bids', ['auction_id', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_auction_bids');
    await queryInterface.dropTable('wattmatch_auction_participants');
    await queryInterface.dropTable('wattmatch_auctions');
  },
};
