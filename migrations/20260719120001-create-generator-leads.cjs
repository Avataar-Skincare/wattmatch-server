'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_generator_leads', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, allowNull: false },
      company: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false },
      phone: { type: Sequelize.STRING, allowNull: false },
      state: { type: Sequelize.STRING, allowNull: false },
      capacity: { type: Sequelize.STRING, allowNull: true },
      message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('wattmatch_generator_leads', ['email']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_generator_leads');
  },
};
