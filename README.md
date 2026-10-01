# code-sketch

Uma skill do [Claude Code](https://claude.com/claude-code) que **explica código desenhando**.
Você aponta uma função, um fluxo ou alguns módulos e ela gera um diagrama pequeno e editável no
[Excalidraw](https://excalidraw.com), confere o resultado olhando uma prévia em PNG e explica o desenho passo a passo no chat.

<p align="center"><img src="docs/hit-to-levelup.png" width="340" alt="Exemplo: do golpe da arma ao level-up"></p>

*(Exemplo real: um jogo estilo Vampire Survivors. O diagrama foi gerado a partir do código.)*

## Como funciona

1. O Claude lê o código e escreve uma **spec** curta: blocos, setas e grupos.
2. Um script (`sketch.mjs`) faz o resto: posiciona tudo, ajusta o tamanho dos blocos e cola as setas nos blocos,
   então ao arrastar um bloco no Excalidraw as setas o seguem.
3. O script também gera um PNG. O Claude olha o PNG, corrige o que ficou ruim e só então te entrega o `.excalidraw`.
4. Por fim ele explica o diagrama em poucas linhas, apontando `arquivo:linha`.

**Diagramas pequenos de propósito.** O script recusa diagramas com mais de 12 blocos, setas demais ou setas
cruzadas, e diz como encolher (dividir em visão geral + detalhes, juntar blocos, usar grupos em vez de setas).
Diagrama que ninguém consegue entender de relance não ajuda a entender código.

## Instalar

Precisa de Node 18+. As dependências (`elkjs`, `@resvg/resvg-js`) se instalam sozinhas na primeira execução.

Como plugin do Claude Code:

```
/plugin marketplace add EduardoMilani8/code-sketch
/plugin install code-sketch@code-sketch
```

Ou copiando a skill:

```bash
git clone https://github.com/EduardoMilani8/code-sketch
cp -r code-sketch/skills/code-sketch ~/.claude/skills/
```

## Usar

Peça normalmente:

> Explica como os inimigos nascem nesse projeto com um diagrama no excalidraw.

O arquivo sai em `./diagrams/<nome>.excalidraw` (com `.png` e `.svg` ao lado).
Para abrir, arraste o arquivo para excalidraw.com ou use a extensão "Excalidraw" do VS Code.

### A spec

É isto que o Claude escreve (o diagrama acima vem dela):

```json
{
  "title": "Do golpe ao level-up",
  "takeaway": "GameSession é o maestro: um golpe vira dano, loot e XP.",
  "nodes": [
    { "id": "hit",  "label": "HitEnemy", "sub": "GameSession.cs:308", "focus": true },
    { "id": "loot", "label": "DropLoot", "sub": "GameSession.cs:334" }
  ],
  "edges": [{ "from": "hit", "to": "loot", "label": "morreu" }]
}
```

Você também pode rodar o script direto:

```bash
node skills/code-sketch/scripts/sketch.mjs minha-spec.json --out ./diagrams
```

Detalhes do formato em [`SKILL.md`](skills/code-sketch/SKILL.md); dois exemplos completos em
[`references/examples`](skills/code-sketch/references/examples).

## Limitações (v0.1)

Só diagramas de fluxo/estrutura (sem diagrama de sequência ainda). A prévia em PNG usa uma fonte comum;
no Excalidraw o desenho aparece no estilo rabiscado. Cadeias longas saem na vertical.

## Licença

MIT
