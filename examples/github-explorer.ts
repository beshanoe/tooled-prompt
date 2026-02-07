import "./env.js";
import { prompt } from "tooled-prompt";

function getUser(username: string) {
  return fetch(`https://api.github.com/users/${username}`).then((r) =>
    r.json(),
  );
}

function getRepos(username: string, page: number) {
  return fetch(
    `https://api.github.com/users/${username}/repos?per_page=30&sort=updated&page=${page}`,
  )
    .then((r) => r.json())
    .then((items) =>
      items.map(({ full_name, description }: any) => ({
        full_name,
        description,
      })),
    );
}

await prompt`
  Look up the GitHub user "sindresorhus" using ${getUser}, then fetch all their
  public repos with ${getRepos}.

  Analyze their tech stack, most active languages, and suggest what kind of
  open-source project they should start next.
`();
