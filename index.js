const contentful = require("contentful");
const contentfulManagement = require("contentful-management");
const { normalizeEntries } = require("./lib/contentful-util");
const pkg = require("./package.json");

module.exports.name = pkg.name;

module.exports.options = {
  accessToken: {
    env: "CONTENTFUL_ACCESS_TOKEN",
    private: true
  },
  environment: {},
  pollingInterval: {
    default: 5000
  },
  projectId: {},
  watch: {
    default: false,
    runtimeParameter: "watch"
  }
};

module.exports.bootstrap = async ({
  getPluginContext,
  log,
  options,
  refresh,
  setPluginContext
}) => {
  const clientManagement = contentfulManagement.createClient({
    accessToken: options.accessToken
  });
  const space = await clientManagement.getSpace(options.spaceId);
  const { items: apiKeys } = await space.getApiKeys();

  let apiKey = apiKeys.find(({ name }) => name === pkg.name);

  if (!apiKey) {
    apiKey = await space.createApiKey({
      name: pkg.name,
      environments: [
        {
          sys: {
            type: "Link",
            linkType: "Environment",
            id: options.environment
          }
        }
      ]
    });
  }

  const client = contentful.createClient({
    accessToken: apiKey.accessToken,
    space: options.spaceId
  });
  const { assets, entries, nextSyncToken } = await client.sync({
    initial: true,
    resolveLinks: true
  });

  const { items: contentTypes } = await client.getContentTypes();
  const models = contentTypes.map(contentType => ({
    source: pkg.name,
    modelName: contentType.sys.id,
    modelLabel: contentType.name || contentType.sys.id,
    projectId: options.spaceId,
    projectEnvironment: options.environment,
    fieldNames: contentType.fields.map(field => field.id)
  }));

  setPluginContext({
    entries,
    models,
    nextSyncToken
  });

  if (options.watch) {
    setInterval(async () => {
      const { assets, entries, nextSyncToken } = getPluginContext();
      const response = await client.sync({
        nextSyncToken
      });

      if (response.nextSyncToken === nextSyncToken) {
        return;
      }

      // Handling updated assets.
      response.assets.forEach(asset => {
        const index = assets.findIndex(({ sys }) => sys.id === asset.sys.id);

        if (index !== -1) {
          assets[index] = asset;
        }
      });

      // Handling updated entries.
      response.entries.forEach(entry => {
        const index = entries.findIndex(({ sys }) => sys.id === entry.sys.id);

        if (index !== -1) {
          entries[index] = entry;
        }
      });

      setPluginContext({
        entries,
        nextSyncToken: response.nextSyncToken
      });

      refresh();
    }, options.pollingInterval);
  }
};

module.exports.transform = ({ data, getPluginContext }) => {
  const { entries = [], models } = getPluginContext();
  const normalizedEntries = normalizeEntries(entries);

  return {
    ...data,
    models: data.models.concat(models),
    objects: data.objects.concat(normalizedEntries)
  };
};

module.exports.getOptionsFromSetup = ({ answers }) => {
  return {
    accessToken: answers.accessToken,
    environment: answers.environment,
    spaceId: answers.spaceId
  };
};

module.exports.getSetup = ({ chalk, inquirer, ora }) => {
  return async () => {
    const answers = {};
    const { accessToken } = await inquirer.prompt([
      {
        type: "input",
        name: "accessToken",
        message: `What is your Contentful Personal Access Token? ${chalk.reset(
          "To create one, see https://www.contentful.com/r/knowledgebase/personal-access-tokens/."
        )}`
      }
    ]);

    answers.accessToken = accessToken;

    const client = contentfulManagement.createClient({
      accessToken: answers.accessToken
    });
    const spacesSpinner = ora("Looking for Contentful spaces").start();
    const { items: spaces } = await client.getSpaces();

    spacesSpinner.succeed();

    if (spaces.length === 1) {
      answers.spaceId = spaces[0].sys.id;

      ora(
        `The only space in the account has been selected: ${chalk.bold(
          spaces[0].name
        )}.`
      ).info();
    } else {
      const { spaceId } = await inquirer.prompt([
        {
          type: "list",
          name: "spaceId",
          message: "Which Contentful space do you want to use?",
          choices: spaces.map(space => ({
            name: space.name,
            value: space.sys.id
          }))
        }
      ]);

      answers.spaceId = spaceId;
    }

    const environmentsSpinner = ora("Looking for environments").start();
    const space = await client.getSpace(answers.spaceId);
    const { items: environments } = await space.getEnvironments();

    environmentsSpinner.succeed();

    if (environments.length === 1) {
      answers.environment = environments[0].sys.id;

      ora(
        `The only environment in the space has been selected: ${chalk.bold(
          environments[0].name
        )}.`
      ).info();
    } else {
      const { environment } = await inquirer.prompt([
        {
          type: "list",
          name: "environment",
          message: "What environment do you want to use?",
          choices: environments.map(environment => ({
            name: environment.name,
            value: environment.sys.id
          })),
          default: environments[0].sys.id
        }
      ]);

      answers.environment = environment;
    }

    return answers;
  };
};