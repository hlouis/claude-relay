var config = {
  repositoryUrl: "https://github.com/hlouis/claude-relay.git",
  branches: [
    { name: "main", prerelease: "beta" },
    { name: "release" }
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    "@semantic-release/npm",
    ["@semantic-release/git", {
      assets: ["package.json", "CHANGELOG.md"],
      message: "Release ${nextRelease.version}"
    }],
    ["@semantic-release/github", {
      successComment: "This issue has been resolved in version ${nextRelease.version} (${nextRelease.channel || 'stable'}).\n\nTo update, run:\n```\nnpx @hlouis/clay@${nextRelease.version}\n```",
      releasedLabels: ["released: ${nextRelease.channel || 'stable'}"]
    }]
  ]
}

module.exports = config
