const { DefaultArtifactClient } = require("@actions/artifact");
const core = require("@actions/core");
const github = require("@actions/github");
const fetch = require("node-fetch");
const fs = require("fs");

const issueSentenceForSlack = (issue) => {
  const url = issue.url.replace(
    /(\S*)\/hokutoresident/gi,
    "https://github.com/hokutoresident"
  );
  return `- <${url}| ${issue.title}> by ${issue.user.login}\n`;
};

const issueSentenceForGitHub = (issue) => {
  const url = issue.url.replace(
    /(\S*)\/hokutoresident/gi,
    "https://github.com/hokutoresident"
  );
  return `- [${issue.title}](${url}) ${issue.user.login}\n`;
};

const createDescriptionForGitHub = (issues) => {
  const labels = issues
    .map((issue) => issue.labels)
    .flatMap((issue) => issue)
    .reduce(
      (labels, l) =>
        labels.filter((v) => v.name === l.name).length > 0
          ? labels
          : labels.concat(l),
      []
    );
  const labelSections = labels.reduce((body, label) => {
    const title = `## ${label.name}: ${label.description}\n`;
    const issuesForLabel = issues
      .filter(
        (issue) =>
          issue.labels.filter((issueLabel) => label.name === issueLabel.name)
            .length > 0
      )
      .map((issue) => issueSentenceForGitHub(issue));
    const section = title.concat(...issuesForLabel);
    return body.concat(section);
  }, "");

  const labelEmptyIssues = issues
    .filter((issue) => issue.labels.length === 0)
    .map((issue) => issueSentenceForGitHub(issue));

  const title = "## Label is empty\n";
  const emptySection = title.concat(...labelEmptyIssues);
  return labelSections + emptySection;
};

const createDescriptionForSlack = (issues) => {
  const labels = issues
    .map((issue) => issue.labels)
    .flatMap((issue) => issue)
    .reduce(
      (labels, l) =>
        labels.filter((v) => v.name === l.name).length > 0
          ? labels
          : labels.concat(l),
      []
    );
  const labelSections = labels.reduce((body, label) => {
    const title = `*${label.name}*: ${label.description}\n`;
    const issuesForLabel = issues
      .filter(
        (issue) =>
          issue.labels.filter((issueLabel) => label.name === issueLabel.name)
            .length > 0
      )
      .map((issue) => issueSentenceForSlack(issue));
    const section = title.concat(...issuesForLabel);
    return body.concat(section);
  }, "");

  const labelEmptyIssues = issues
    .filter((issue) => issue.labels.length === 0)
    .map((issue) => issueSentenceForSlack(issue));

  const title = "*Label is empty*\n";
  const emptySection = title.concat(...labelEmptyIssues);
  return labelSections + emptySection;
};

const uploadArtifact = async (version, body) => {
  const artifactName = `${version}_description`;
  const fileName = `${artifactName}.txt`;
  fs.writeFile(fileName, `${body}`, (error) => {
    if (!error) return;
    console.log(`write file :${error}`);
  });
  const artifactClient = new DefaultArtifactClient();
  const files = [fileName];
  const rootDirectory = ".";
  const options = { continueOnError: false };
  await artifactClient.uploadArtifact(
    artifactName,
    files,
    rootDirectory,
    options
  );
};

/**
 *
 * @param {octokit} octokit
 * @param {string} version
 * @param {
 *   owner: string,
 *   repo: string
 * }
 * @returns milestone: object
 */
const fetchTargetMilestone = async (octokit, { version, owner, repo }) => {
  let milestone = null;
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listMilestones,
    {
      owner: owner,
      repo: repo,
    }
  )) {
    const milestones = response.data.filter((m) => m.title === version);
    if (milestones.length === 0) {
      return;
    }
    milestone = milestones[0];
  }
  if (!milestone) {
    core.info(`${repo} has not '${version}' milestone`);
    throw new Error("milestone is not found");
  }
  return milestone;
};

/**
 *
 * @param {octokit} octokit
 * @param {
 *   owner: string,
 *   repo: string
 *   mileStoneNumber: string,
 * }
 * @returns issues: object[]
 */
const fetchIssues = async (octokit, { owner, repo, mileStoneNumber }) => {
  let responses = [];
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      owner: owner,
      repo: repo,
      milestone: mileStoneNumber,
      state: "closed",
      per_page: 100,
    }
  )) {
    responses.push(...response.data);
  }
  return responses.flat();
};

const generateDescriptionFromRepository = async (
  octokit,
  version,
  repository
) => {
  const milestone = await fetchTargetMilestone(octokit, {
    version: version,
    owner: github.context.repo.owner,
    repo: repository,
  });
  if (!milestone) {
    return {
      descriptionForSlack: "",
      descriptionForGitHub: "",
    };
  }
  core.info(`Start create release for milestone ${milestone.title}`);

  const issues = await fetchIssues(octokit, {
    owner: github.context.repo.owner,
    repo: repository,
    mileStoneNumber: milestone.number,
  });

  if (issues.length === 0) {
    core.info(`${repository} has no issues for milestone ${milestone.title}`);
    return {
      descriptionForSlack: "",
      descriptionForGitHub: "",
    };
  }

  const descriptionForSlack = createDescriptionForSlack(issues);
  const descriptionForGitHub = createDescriptionForGitHub(issues);
  return {
    descriptionForSlack,
    descriptionForGitHub,
  };
};

const generateReleaseNote = async (version) => {
  if (typeof version !== "string") {
    throw new Error("version not a string");
  }
  const token = core.getInput("token");
  if (typeof token !== "string") {
    throw new Error("token is not valid");
  }
  const octokit = github.getOctokit(token);

  const repositories = [
    github.context.repo.repo,
    // "zefyr",
    // "hokuto-functions",
  ];

  // descriptions: {
  //   descriptionForSlack: string;
  //   descriptionForGitHub: string;
  // }[]
  // description = {
  //   descriptionForSlack: string;
  //   descriptionForGitHub: string;
  // }
  const description = await Promise.all(
    repositories.map(async (repo) => {
      return await generateDescriptionFromRepository(octokit, version, repo);
    })
  ).then((descriptions) => {
    return descriptions.reduce(
      (des, current, index) => {
        return {
          descriptionForSlack: `${des["descriptionForSlack"]}\n*${repositories[index]}*\n${current["descriptionForSlack"]}`,
          descriptionForGitHub: `${des["descriptionForGitHub"]}\n# ${repositories[index]}\n${current["descriptionForGitHub"]}`,
        };
      },
      {
        descriptionForSlack: "",
        descriptionForGitHub: "",
      }
    );
  });

  console.log("description", JSON.stringify(description, null, 2));

  await uploadArtifact(version, description["descriptionForGitHub"]);
  await fetch("https://hooks.zapier.com/hooks/catch/11137744/b9i402e/", {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version,
      description: description["descriptionForSlack"],
    }),
  });
};

module.exports = generateReleaseNote;
