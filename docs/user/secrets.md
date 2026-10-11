# Secrets

Save an API key or token once and agents can use it in shell commands without the value appearing
in chat. Secrets belong to the environment: agents in every project and thread on that server see
the same list.

To add one, open the thread details panel and choose **Secrets → Add secret…**. Name it, such as
`CLOUDFLARE_API_TOKEN`, using capital letters, numbers and underscores, and paste the value. You
can't view a value after saving it, only replace or delete it. Saving and deleting need permission
to change the environment's settings.

Agents see each secret's name and the path of the file that holds it, never the value, and use it
inside a command, such as `curl -H "Authorization: Bearer $(cat <path>)"`. Ask for "my Cloudflare
token" and the agent finds it.

Each secret is a file in T3 Code's data folder on the server, readable only by the account T3 Code
runs as. Agents run as that account too, so they can read the value, and one that misbehaves could
print it. Save only keys you are willing to let agents use, and rotate any that end up somewhere
they shouldn't.

Secrets are managed from web and desktop. For a value an agent needs only once, it can ask you for
it in the thread instead.
