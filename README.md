# arquivador

Leitor e escritor de arquivos `.tar` no formato POSIX ustar, escrito do zero.
**Zero dependências.**

A prova de que está certo não é um teste inventado por mim: é o `tar` do
sistema lendo o que este projeto grava, e este projeto lendo o que o `tar`
grava. Os dois lados rodam na integração contínua.

```bash
$ arq listar projeto.tar -v
-rw-r--r--        10 2026-09-22 13:05 projeto/leiame.md
drwxr-xr-x         0 2026-09-22 13:05 projeto/src/
-rw-r--r--        38 2026-09-22 13:05 projeto/src/soma.js
lrwxrwxrwx         0 2026-09-22 13:05 projeto/atalho.md -> leiame.md

$ tar -tvf projeto.tar   # o tar do sistema, no mesmo arquivo
-rw-r--r-- 0/0              10 2026-09-22 10:05 projeto/leiame.md
drwxr-xr-x 0/0               0 2026-09-22 10:05 projeto/src/
-rw-r--r-- 0/0              38 2026-09-22 10:05 projeto/src/soma.js
lrwxrwxrwx 0/0               0 2026-09-22 10:05 projeto/atalho.md -> leiame.md
```

## Por que existe

O `.tar` é o formato de empacotamento mais usado do mundo e tem **uma página**
de especificação útil. Ler ele por dentro explica um monte de coisa que a gente
aceita sem pensar.

### 1. Não existe índice

Um tar é uma sequência de blocos de 512 bytes: cabeçalho, conteúdo preenchido
até fechar o múltiplo de 512, cabeçalho, conteúdo, e no fim **dois blocos
zerados**. Só isso.

Daí saem três coisas que todo mundo já notou sem saber o porquê:

- **`tar` sozinho não comprime.** Quem comprime é o `gzip` depois — por isso
  `.tar.gz`, e por isso a ordem importa.
- **Extrair um arquivo do meio de um tar de 4 GB lê os 4 GB.** A única forma de
  achar o próximo cabeçalho é pular o conteúdo do atual.
- **Dá para concatenar dois tar** e, com tolerância, o resultado ainda é
  legível — o formato não tem cabeçalho global nenhum.

### 2. Números em octal, como texto

O campo de tamanho tem 12 bytes e guarda `00000000144` — o número em base 8,
em ASCII, terminado em nulo. É de 1979 e nunca mudou.

Isso dá 11 dígitos octais, ou seja, **8 GB**. Foi por isso que precisou existir
a extensão do GNU que liga o bit mais alto do primeiro byte e passa a guardar
o número em binário. Sem entender essas duas formas, um tar grande vira
"tamanho inválido".

### 3. A soma de verificação que cobre a si mesma

O cabeçalho tem um campo com a soma de todos os seus 512 bytes — incluindo o
próprio campo da soma. A saída, em 1979, foi calcular fingindo que ele é um
branco de **oito espaços**. Todo mundo ainda faz assim, e quem calcula
diferente produz um tar que o `tar` recusa com "checksum error".

Há um teste que troca um byte do cabeçalho e exige que o `tar` do sistema
recuse o arquivo — é o que prova que a soma implementada aqui é a dele.

### 4. O nome tem 100 bytes, e o jeito de esticar é curioso

O ustar acrescentou um campo `prefixo` de 155 bytes, que se junta ao nome com
uma barra no meio. Parece que o limite virou 255, mas **não é bem isso**: são
dois campos separados, então

```
a/b/c/…/arquivo.txt   (200 bytes, com barras) → cabe
umnomesembarranenhuma…(120 bytes, sem barra)  → não cabe
```

Acima disso entra a extensão `L` do GNU: uma entrada cujo conteúdo é o caminho
comprido da entrada seguinte. Este projeto escreve e lê essa extensão, e lê
também os registros PAX — cujo tamanho, mais uma vez, **inclui ele mesmo**.

### 5. Extrair é perigoso

Um tar malicioso traz uma entrada chamada `../../.ssh/authorized_keys`. Um
extrator ingênuo faz `join(destino, nome)` e escreve exatamente ali. É o *tar
slip*, e já rendeu CVE em biblioteca grande.

Aqui toda entrada passa por uma resolução que confere se o caminho continua
dentro da pasta de destino — e o **destino da ligação simbólica** também, que é
o buraco que sobra depois de fechar o primeiro: `atalho -> ../../etc/passwd`
não tem `..` no nome da entrada.

## A API

```js
import { Escritor, empacotar, listar, extrair } from 'arquivador';

const escritor = new Escritor();

escritor.adicionarPasta('projeto');
escritor.adicionar({ nome: 'projeto/a.txt', modo: 0o644 }, 'oi\n');
escritor.adicionarSimbolica('projeto/atalho', 'a.txt');

const bytes = escritor.finalizar();

// De uma pasta do disco, com data fixada para o resultado ser reproduzível:
const tar = await empacotar('./projeto', { alterado: new Date(0) });

listar(tar);                  // [{ nome, tamanho, modo, alterado, tipo }, …]
await extrair(tar, './saida', { pularPerigosas: true });
```

`alterado: new Date(0)` importa mais do que parece: sem fixar a data,
empacotar a mesma pasta duas vezes gera arquivos com bytes diferentes, e
qualquer verificação por hash deixa de funcionar.

## Linha de comando

```
arq criar <saida.tar> <pasta>      empacota a pasta
arq listar <arquivo.tar>           lista o conteúdo
arq extrair <arquivo.tar> <pasta>  extrai para a pasta

-v, --detalhado   modo, tamanho e data, como o "tar -tv"
-f, --fixar       fixa a data em 1970 (dois empacotamentos, bytes iguais)
-s, --sem-medo    pula entradas que escapariam, em vez de parar
```

## Estrutura

```
src/cabecalho.js  o bloco de 512: campos, octal, soma, nome comprido
src/escritor.js   monta o arquivo, entrada L do GNU, empacota uma pasta
src/leitor.js     percorre os blocos, PAX, extração com guarda de caminho
src/cli.js        criar, listar, extrair
```

## Rodando

```bash
npm test
```

56 testes. Os oito mais importantes envolvem o `tar` de verdade: ele lista e
extrai o que este grava (inclusive nome comprido, binário e ligação
simbólica), este lê o que ele grava, e um byte trocado faz ele recusar. Se o
`tar` não estiver instalado, esses testes se anunciam como pulados em vez de
passar caladamente.

Node 20 ou mais novo.

## Limites conhecidos

- **Tudo em memória.** Um tar de 4 GB precisa de 4 GB de RAM. Não há leitura
  nem escrita em fluxo.
- **Sem compressão.** Não lê `.tar.gz` nem `.tar.bz2`; use `node:zlib` por
  fora, que é exatamente o que o `tar -z` faz.
- **Escreve ustar clássico**, não PAX. Lê os registros PAX que o GNU e o
  bsdtar geram, mas não os produz — então caminho acima de 255 bytes sai como
  entrada `L` do GNU.
- **Sem arquivos esparsos**, sem dispositivos de bloco, sem FIFO.
- **Dono e grupo vão como 0.** Não há tentativa de preservar `uid`/`gid` nem
  de restaurá-los na extração, que exigiria privilégio.
- Modo de arquivo no Windows é aproximado: o sistema não tem bit de execução,
  então uma pasta empacotada lá volta como `drw-rw-rw-`.

## Licença

MIT.
